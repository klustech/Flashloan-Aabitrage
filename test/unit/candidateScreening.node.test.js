const test = require('node:test');
const assert = require('node:assert/strict');
const { providers, utils } = require('ethers');
const { bn } = require('../../server/bot/units');
const { TokenRegistry } = require('../../server/market/tokenRegistry');
const { PoolRegistry } = require('../../server/market/poolRegistry');
const { PoolStateCache } = require('../../server/market/poolStateCache');
const { CandidateIndex } = require('../../server/bot/opportunityEngine');
const { Coordinator } = require('../../server/bot/coordinator');
const { QuoteEngine } = require('../../server/bot/quoteEngine');
const { TradingStateMachine } = require('../../server/bot/stateMachine');
const { TradeLedger } = require('../../server/bot/tradeLedger');
const { productionProfile } = require('../../server/config/productionProfile');
const { getAmountOutV2 } = require('../../server/scripts/ammMath');
const a = n => `0x${n.toString(16).padStart(40, '0')}`;
const A=a(1), B=a(2), R=a(90), F=a(91), P=a(92), Q=a(93);
const block = n => ({number:n,hash:utils.hexZeroPad(utils.hexlify(n),32),parentHash:utils.hexZeroPad(utils.hexlify(n-1),32),baseFeePerGas:bn(0)});
const tick = () => new Promise(resolve=>setImmediate(resolve));
function universe(){
  const tokens=new TokenRegistry(null,1),symbols=['DAI','WETH','USDC','USDT','WBTC'],addresses=symbols.map((s,i)=>a(i+1));
  symbols.forEach((symbol,i)=>tokens.register({symbol,address:addresses[i],decimals:18}));
  const registry=new PoolRegistry(tokens),pool=(dex,poolAddress,token0,token1,extra)=>registry.add({dex,poolAddress,router:R,factory:F,token0,token1,stateBlock:1,stateTimestamp:Date.now(),...extra});
  pool('uniswap_v2',P,A,B,{reserve0:utils.parseEther('10000'),reserve1:utils.parseEther('50000')});
  pool('sushiswap_v2',Q,A,B,{reserve0:utils.parseEther('10000'),reserve1:utils.parseEther('10000')});
  // High marginal V3 spreads but bad executable returns model the misleading
  // triangle prefix seen in the five-token local-fork report.
  let id=100;
  for(let i=0;i<5;i++)for(let j=i+1;j<5;j++)for(const dex of ['uniswap_v3','pancake_v3'])for(const feeTier of [100,500,3000,10000]){
    pool(dex,a(id++),addresses[i],addresses[j],{sqrtPriceX96:bn(2).pow(96).mul(i===0&&j===1?100:2),liquidity:utils.parseEther('100000'),feeTier});
  }
  const profile={...productionProfile({CONTRACT_ADDRESS:a(999)}),tokens:Object.fromEntries(symbols.map((s,i)=>[s,addresses[i]]))};
  return {tokens,registry,profile};
}
function screenFixture(candidates,profile={}){
  const c=Object.create(Coordinator.prototype),state=new TradingStateMachine();state.paper();
  Object.assign(c,{state,profile:{maxCandidates:4,maxScreenedCandidates:48,maxSizedCandidates:1,scanBudgetMs:5000,...profile},scanStats:{screened:0},candidateIndex:{markScreened:()=>{}},refresh:async r=>r,terms:async()=>({premiumBps:9}),bounds:()=>({minInput:bn(1),maxInput:bn(100)}),reject:async()=>{},converter:()=>({toNative:async x=>x}),evaluate:async()=>{throw new Error('Not profitable after premium');}});
  const routes=Array.from({length:candidates},(_,i)=>({id:String(i),borrowToken:A,legs:[],spreadPpm:bn(10000)}));
  return {c,routes,run:signal=>c.screenCandidates(routes,block(1),state.revision,signal||new AbortController().signal,Date.now()+c.profile.scanBudgetMs)};
}
test('five-token PAPER cycle discovers a known profitable V2 route beyond misleading marginal triangles',async()=>{
  const f=universe(),index=new CandidateIndex(),changed=new Set(f.registry.values().map(p=>p.poolAddress));
  const marginal=index.candidates(f.registry,[A],1,changed);
  const good=marginal.find(r=>r.legs[0].poolAddress===P&&r.legs[1].poolAddress===Q);
  assert.ok(marginal.length>48);assert.ok(good);assert.ok(!marginal.slice(0,4).some(r=>r.id===good.id));
  assert.ok(marginal.slice(0,4).every(r=>r.legs.length===3));
  const state=new TradingStateMachine();state.paper();const ledger=new TradeLedger({file:null});let calls=0,estimates=0,signed=0;
  const adapters=Object.fromEntries(['uniswap_v2','sushiswap_v2','uniswap_v3','pancake_v3'].map(dex=>[dex,{quoteExactInput:async(l,x)=>l.protocolVersion===2?getAmountOutV2(x,l.reserveIn,l.reserveOut,l.feeBps):bn(x).div(2),buildSwapStep:()=>({})}]));
  const c=Object.create(Coordinator.prototype);
  Object.assign(c,{state,ledger,profile:f.profile,tokens:f.tokens,overrides:{},poolRegistry:f.registry,candidateIndex:index,marketCache:{head:block(1),sync:async()=>({registry:f.registry,changedPools:changed}),status:()=>({block:1,pools:f.registry.values().length})},quoter:new QuoteEngine(adapters),flashloan:{terms:async()=>({premiumBps:9,availableLiquidity:utils.parseEther('50000')}),fee:(x,bps)=>bn(x).mul(bps).add(5000).div(10000)},operatorAddress:A,contract:{address:a(999),interface:{encodeFunctionData:()=> '0x'},profitRecipient:async()=>B},provider:{call:async()=>{calls++;return '0x';},estimateGas:async()=>{estimates++;return bn(100000);},getBlock:async()=>block(1)},converter:()=>({toNative:async x=>bn(x),toBorrow:async x=>bn(x)}),emit:()=>{},burnIn:{record:()=>{}},execution:{reconcile:async()=>0,execute:async()=>{signed++;assert.fail('PAPER must not sign');}}});
  c.initialize=async()=>{};
  const result=await c.cycle();
  assert.equal(result.simulated,true);assert.equal(signed,0);assert.equal(calls,2);assert.equal(estimates,1);
  assert.equal(ledger.recent().find(r=>r.status==='SIMULATED').candidateId,good.id);
  assert.ok(c.scanStats.screened>4);assert.ok(c.scanStats.screened<=48);assert.equal(c.scanStats.screeningStopReason,'enough_profitable');
});
test('progressive screening reaches profitable candidates after several failed batches with at most two concurrent evaluations',async()=>{
  const f=screenFixture(30);let active=0,peak=0;
  f.c.evaluate=async(route,amount)=>{active++;peak=Math.max(peak,active);await tick();active--;if(route.id!=='10')throw new Error('Not profitable after premium');return {quote:{route,borrowAmount:amount},economics:{profitable:true,expectedNetProfit:bn(10)}};};
  const result=await f.run();assert.equal(result[0].route.id,'10');assert.equal(f.c.scanStats.screened,12);assert.equal(peak,2);assert.equal(f.c.scanStats.screeningBatches,3);
});
test('candidate cap bounds failed screening and batches never exceed it',async()=>{
  const f=screenFixture(100,{maxScreenedCandidates:7});assert.deepEqual(await f.run(),[]);
  assert.equal(f.c.scanStats.screened,7);assert.equal(f.c.scanStats.screeningAttempted,7);assert.equal(f.c.scanStats.screeningStopReason,'candidate_cap');
});
test('screening deadline retains completed quotes and ignores late results while reserving preparation time',async()=>{
  const f=screenFixture(10,{scanBudgetMs:80});const releases=[];const started=Date.now();
  f.c.evaluate=(route,amount)=>route.id==='0'?Promise.resolve({quote:{route,borrowAmount:amount},economics:{profitable:true,expectedNetProfit:bn(10)}}):new Promise(resolve=>releases.push(()=>resolve({quote:{route,borrowAmount:amount},economics:{profitable:true,expectedNetProfit:bn(999)}})));
  const result=await f.run();assert.deepEqual(result.map(r=>r.route.id),['0']);assert.equal(f.c.scanStats.screeningStopReason,'screening_budget');
  assert.ok(Date.now()-started<250);assert.equal(f.c.scanStats.screeningPassed,1);
  for(const release of releases)release();await tick();assert.equal(result.length,1);assert.equal(f.c.scanStats.screeningPassed,1);
});
test('outer cancellation and state revision changes discard screening work',async()=>{
  const f=screenFixture(20);const controller=new AbortController();let active=0;
  f.c.evaluate=async()=>{active++;controller.abort();return {economics:{profitable:true,expectedNetProfit:bn(10)}};};
  await assert.rejects(f.run(controller.signal),{name:'AbortError'});assert.ok(active<=2);assert.equal(f.c.scanStats.screeningPassed,0);
  const g=screenFixture(20);g.c.evaluate=async()=>{g.c.state.pause();throw new Error('quote failed');};
  await assert.rejects(g.run(),{name:'AbortError'});
});
test('candidate queue alternates direct/triangle routes, prioritizes affected pools and rotates failed prefixes',()=>{
  const f=universe(),index=new CandidateIndex(),changed=new Set(f.registry.values().map(p=>p.poolAddress));
  const first=index.screeningCandidates(f.registry,[A],1,changed);assert.equal(first[0].legs.length,2);assert.equal(first[1].legs.length,3);
  first.slice(0,48).forEach(r=>index.markScreened(r.id));
  const next=index.screeningCandidates(f.registry,[A],2,new Set());assert.ok(next.filter(r=>r.legs.length===3).slice(0,20).every(r=>!first.slice(0,48).some(old=>old.id===r.id)));
  assert.ok(next.some(r=>!first.slice(0,48).some(old=>old.id===r.id)));
  const affected=index.screeningCandidates(f.registry,[A],3,new Set([P]));assert.ok(index.stats.affectedProfitable>0);
  assert.ok(affected.slice(0,2).every(r=>r.legs.some(l=>l.poolAddress===P)));
  assert.ok(affected.slice(2,4).every(r=>r.legs.every(l=>l.poolAddress!==P)));
});
test('real ethers v5 filters support incremental logs through FallbackProvider without address arrays',async()=>{
  const sent=[];
  class Rpc extends providers.StaticJsonRpcProvider {
    constructor(){super('http://unused',{chainId:1,name:'test'});}
    async perform(method,params){if(method==='getBlockNumber')return 2;if(method==='getLogs'){sent.push(params.filter);return [];}throw new Error(method);}
  }
  const rpc=new Rpc();await assert.rejects(rpc.getLogs({address:[P,Q],fromBlock:1,toBlock:2}),/invalid address or ENS name/);
  const provider=new providers.FallbackProvider([rpc],1),f=universe();provider.getBlock=async n=>block(n);
  const cache=new PoolStateCache({provider,tokens:f.tokens,profile:{...f.profile,routers:{uniswap_v2:{router:R,factory:F}}},file:null,adapters:{uniswap_v2:{discoverPools:async()=>f.registry.values().filter(p=>p.poolAddress===P||p.poolAddress===Q),getDynamicState:async()=>assert.fail('unchanged pools must be reused')}}});
  await cache.sync(block(1));await cache.sync(block(2));
  assert.equal(cache.stats.logFallbacks,0);assert.equal(cache.stats.reusedPools,2);assert.equal(sent.length,1);
  assert.equal(sent[0].address,undefined);assert.equal(sent[0].topics[0].length,8);rpc.removeAllListeners();provider.removeAllListeners();
});
test('topic-filtered logs ignore untracked pools, refresh tracked state and retain full-refresh recovery',async()=>{
  const f=universe();let dynamic=0;const adapter={discoverPools:async()=>f.registry.values().filter(p=>p.poolAddress===P||p.poolAddress===Q),getDynamicState:async pool=>{dynamic++;return {reserve0:pool.reserve0,reserve1:pool.reserve1};}};
  const provider={getBlock:async n=>block(n),getLogs:async()=>[{address:a(444),blockNumber:2,blockHash:block(2).hash}]};
  const cache=new PoolStateCache({provider,tokens:f.tokens,profile:{...f.profile,routers:{uniswap_v2:{router:R,factory:F}}},file:null,adapters:{uniswap_v2:adapter,sushiswap_v2:adapter}});
  await cache.sync(block(1));await cache.sync(block(2));assert.equal(dynamic,0);
  provider.getLogs=async()=>[{address:P,blockNumber:3,blockHash:block(3).hash}];await cache.sync(block(3));assert.equal(dynamic,1);
  provider.getLogs=async()=>{throw new Error('RPC log limit');};await cache.sync(block(4));assert.equal(dynamic,3);assert.equal(cache.stats.lastLogError,'RPC log limit');
  provider.getLogs=async()=>[];await cache.sync(block(5));assert.equal(cache.stats.lastLogError,null);assert.equal(cache.stats.logFallbacks,1);
});
test('all V2/V3 state-changing topics including Pancake-specific Swap trigger tracked pool refresh',async()=>{
  const f=universe(),pool=f.registry.values().find(p=>p.dex==='pancake_v3'),events=[
    'Sync(uint112,uint112)','Initialize(uint160,int24)',
    'Swap(address,address,int256,int256,uint160,uint128,int24)',
    'Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)',
    'Mint(address,address,int24,int24,uint128,uint256,uint256)',
    'Burn(address,int24,int24,uint128,uint256,uint256)'];
  let dynamic=0,nextTopic;
  const provider={getBlock:async n=>block(n),getLogs:async filter=>filter.topics[0].includes(nextTopic)?[{address:pool.poolAddress,topics:[nextTopic],blockNumber:filter.toBlock,blockHash:block(filter.toBlock).hash}]:[]};
  const adapter={discoverPools:async()=>[pool],getDynamicState:async()=>{dynamic++;return {sqrtPriceX96:bn(2).pow(96),liquidity:bn(100)};}};
  const cache=new PoolStateCache({provider,tokens:f.tokens,profile:{...f.profile,routers:{pancake_v3:{router:R,factory:F}}},adapters:{pancake_v3:adapter},file:null});
  await cache.sync(block(1));
  for(let i=0;i<events.length;i++){nextTopic=utils.id(events[i]);await cache.sync(block(i+2));assert.equal(dynamic,i+1);}
  assert.equal(cache.stats.logFallbacks,0);
});
test('factory log filtering survives persisted topology restart with the real ethers v5 formatter',async()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arb-filter-')),file=path.join(dir,'pools.json');
  try{
    const f=universe();let discovered=0,verified=0,filters=[];
    class Rpc extends providers.StaticJsonRpcProvider {
      constructor(){super('http://unused',{chainId:1,name:'test'});}
      async perform(method,params){if(method==='getBlockNumber')return 2;if(method==='getLogs'){filters.push(params.filter);return [];}throw new Error(method);}
    }
    const provider=new Rpc();provider.getBlock=async n=>block(n);
    const adapter={discoverPools:async()=>{discovered++;return [f.registry.values().find(p=>p.poolAddress===P)];},getPoolState:async p=>p,validatePool:async()=>{verified++;}};
    const options={provider,tokens:f.tokens,profile:{...f.profile,routers:{uniswap_v2:{router:R,factory:F}}},adapters:{uniswap_v2:adapter},file};
    await new PoolStateCache(options).sync(block(1));const restored=new PoolStateCache(options);await restored.sync(block(2));
    assert.equal(discovered,1);assert.equal(verified,1);assert.equal(filters.length,1);assert.equal(filters[0].address,undefined);
    assert.deepEqual(filters[0].topics,[[utils.id('PairCreated(address,address,address,uint256)'),utils.id('PoolCreated(address,address,uint24,int24,address)')].sort()]);
    provider.removeAllListeners();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
