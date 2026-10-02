const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bn } = require('../../server/bot/units');
const { TokenRegistry } = require('../../server/market/tokenRegistry');
const { PoolRegistry } = require('../../server/market/poolRegistry');
const { PoolStateCache } = require('../../server/market/poolStateCache');
const { CandidateIndex } = require('../../server/bot/opportunityEngine');
const { QuoteEngine } = require('../../server/bot/quoteEngine');
const { BlockScheduler } = require('../../server/bot/blockScheduler');
const { Coordinator } = require('../../server/bot/coordinator');
const { TradingStateMachine } = require('../../server/bot/stateMachine');
const { TradeLedger } = require('../../server/bot/tradeLedger');
const { ExecutionEngine } = require('../../server/bot/executionEngine');
const a = n => `0x${n.toString(16).padStart(40, '0')}`;
const A = a(1), B = a(2), F = a(3), R = a(4), P = a(10), Q = a(11);
const block = n => ({ number: n, hash: `hash${n}`, parentHash: `hash${n-1}`, baseFeePerGas: bn(1) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(file = null) {
  const tokens = new TokenRegistry(null, 1);
  tokens.register({address:A,symbol:'DAI',decimals:6}); tokens.register({address:B,symbol:'WETH',decimals:18});
  const pools = [P,Q].map((poolAddress,i) => ({dex:'uniswap_v2',poolAddress,router:R,factory:F,token0:A,token1:B,reserve0:bn(1000+i*200),reserve1:bn(1000),stateBlock:1,stateTimestamp:Date.now()}));
  const calls = {discovery:0,metadata:0,dynamic:[],validation:0};
  const adapter = {
    discoverPools:async()=>{calls.discovery++;return pools;},
    getPoolState:async pool=>{calls.metadata++;return {...pool,reserve0:bn(1500)};},
    validatePool:async()=>{calls.validation++;},
    getDynamicState:async(pool,n)=>{calls.dynamic.push([pool.poolAddress,n]);return {reserve0:bn(pool.poolAddress===P?1000+n:1200),reserve1:bn(1000)};},
  };
  const provider = {getBlock:async n=>block(n),getLogs:async()=>[]};
  const profile = {fingerprint:'test-profile',tokenSymbols:['DAI','WETH'],tokens:{DAI:A,WETH:B},routers:{uniswap_v2:{router:R,factory:F}},poolDiscoveryIntervalBlocks:300,maxCachedBlockGap:64,rpcConcurrency:2};
  const cache = new PoolStateCache({provider,adapters:{uniswap_v2:adapter},tokens,profile,file});
  return {tokens,pools,provider,profile,adapter,calls,cache};
}
test('200 steady blocks reuse discovery and read only pools present in confirmed logs',async()=>{
  const f=fixture(); await f.cache.sync(block(1));
  f.provider.getLogs=async({toBlock})=>toBlock%2===0?[{address:P,blockNumber:toBlock,blockHash:block(toBlock).hash}]:[];
  for(let n=2;n<=201;n++)await f.cache.sync(block(n));
  assert.equal(f.calls.discovery,1);assert.equal(f.calls.metadata,0);assert.equal(f.calls.dynamic.length,100);
  assert.ok(f.calls.dynamic.every(([p])=>p===P));assert.ok(f.cache.registry.values().every(p=>p.stateBlock===201));
  assert.equal(f.cache.stats.logRequests,200);assert.equal(f.cache.stats.reusedPools,2);
});
test('restart reloads topology but verifies pool identity and refreshes all state',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arb-pools-'));const file=path.join(dir,'pools.json');
  try {const f=fixture(file);await f.cache.sync(block(1));const restored=new PoolStateCache({...f.cache,file});await restored.sync(block(2));
    assert.equal(f.calls.discovery,1);assert.equal(f.calls.metadata,2);assert.equal(f.calls.validation,2);
    assert.ok(restored.registry.values().every(p=>p.stateBlock===2&&p.reserve0.eq(1500)));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('reorg, missing logs and large block gaps force full state refresh',async()=>{
  const f=fixture();await f.cache.sync(block(1));
  const reorg={...block(2),parentHash:'different-parent'};f.provider.getBlock=async n=>n===2?reorg:block(n);
  await f.cache.sync(reorg);assert.equal(f.cache.stats.reorgs,1);assert.equal(f.calls.dynamic.length,2);
  f.provider.getLogs=async()=>{throw new Error('logs unavailable');};await f.cache.sync(block(3));
  assert.equal(f.cache.stats.logFallbacks,1);assert.equal(f.calls.dynamic.length,4);
  await f.cache.sync(block(100));assert.equal(f.calls.dynamic.length,6);assert.equal(f.calls.discovery,1);
});
test('factory events discover new pools and periodic discovery is bounded',async()=>{
  const f=fixture();await f.cache.sync(block(1));f.provider.getLogs=async()=>[{address:F,blockNumber:2,blockHash:block(2).hash}];
  await f.cache.sync(block(2));assert.equal(f.calls.discovery,2);
  f.provider.getLogs=async()=>[];await f.cache.sync(block(302));assert.equal(f.calls.discovery,3);
});
test('aborted state refresh cannot commit late RPC results to the cache',async()=>{
  const f=fixture();await f.cache.sync(block(1));const old=f.cache.registry;
  f.provider.getLogs=async()=>[{address:P,blockNumber:2,blockHash:block(2).hash}];
  let release;f.adapter.getDynamicState=()=>new Promise(resolve=>{release=resolve;});
  const controller=new AbortController(),pending=f.cache.sync(block(2),{signal:controller.signal});
  await tick();controller.abort();await assert.rejects(pending,{name:'AbortError'});
  release({reserve0:bn(99999),reserve1:bn(1)});await tick();
  assert.equal(f.cache.head.number,1);assert.equal(f.cache.registry,old);
});
test('candidate index reprices affected routes and carries verified unchanged states to the new block',()=>{
  const f=fixture(),registry=new PoolRegistry(f.tokens);for(const p of f.pools)registry.add(p);
  const index=new CandidateIndex();const first=index.candidates(registry,[A],1,new Set([P,Q]),4);
  assert.equal(first.length,1);assert.equal(index.stats.rebuilds,1);
  for(const p of registry.values())registry.add({...p,stateBlock:2});
  const next=index.candidates(registry,[A],2,new Set(),4);assert.equal(index.stats.repriced,0);assert.equal(next[0].legs[0].stateBlock,2);
  registry.add({...f.pools[0],reserve0:bn(1600),stateBlock:3});
  const updated=index.candidates(registry,[A],3,new Set([P]),4);assert.equal(index.stats.rebuilds,1);assert.equal(index.stats.repriced,2);
  assert.notEqual(updated[0].id,first[0].id);
});
test('quote memoization coalesces calls and invalidates on same-height reorg',async()=>{
  let calls=0;const engine=new QuoteEngine({uniswap_v2:{quoteExactInput:async(_l,x)=>{calls++;return bn(x).add(1);}}});
  const leg={dex:'uniswap_v2',poolAddress:P,router:R,tokenIn:A,tokenOut:B};engine.beginBlock('hash1');
  await Promise.all([engine.quoteLeg(leg,100,1),engine.quoteLeg(leg,100,1)]);assert.equal(calls,1);
  engine.beginBlock('new-hash1');await engine.quoteLeg(leg,100,1);assert.equal(calls,2);
  await engine.quoteLeg({...leg,router:a(99)},100,1);assert.equal(calls,3);
});
test('block storm cancels obsolete work, coalesces latest head and never overlaps scans',async()=>{
  const provider=new EventEmitter();let active=0,maxActive=0;const seen=[];
  const scheduler=new BlockScheduler({provider,budgetMs:()=>1000,run:async({signal,triggerBlock})=>{
    active++;maxActive=Math.max(maxActive,active);seen.push(triggerBlock);
    if(triggerBlock===1)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    active--;
  }}).start();
  provider.emit('block',1);provider.emit('block',2);provider.emit('block',3);provider.emit('block',2);
  await tick();await tick();scheduler.stop();assert.deepEqual(seen,[1,3]);assert.equal(maxActive,1);assert.equal(provider.listenerCount('block'),0);
});
test('scan budget aborts work and websocket failure retains HTTP scheduling',async()=>{
  const provider=new EventEmitter(),ws=new EventEmitter();provider.getBlock=async n=>n<100?block(n):null;
  ws._websocket=new EventEmitter();ws.destroy=async()=>{};const seen=[];
  const scheduler=new BlockScheduler({provider,websocketUrl:'ws://test',websocketFactory:()=>ws,budgetMs:()=>5,run:async({signal,triggerBlock})=>{
    seen.push(triggerBlock);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  }}).start();
  ws.emit('block',99999);await tick();assert.equal(seen.length,0);
  ws._websocket.emit('close');provider.emit('block',1);await new Promise(resolve=>setTimeout(resolve,15));
  assert.deepEqual(seen,[1]);assert.equal(scheduler.stats.budgetExpired,1);assert.equal(scheduler.stats.source,'http');scheduler.stop();
});
test('sizing uses executable quotes without full transaction calls',async()=>{
  const c=Object.create(Coordinator.prototype);let quoted=0;
  Object.assign(c,{profile:{minimumRequiredProfit:'1',maxGasUnits:1500000,maxBuilderShareBps:1500},tokens:{parse:()=>bn(1)},flashloan:{fee:()=>bn(1)},quoter:{quoteRoute:async route=>{quoted++;return {route,borrowAmount:bn(100),expectedFinalAmount:bn(200)};}},provider:{call:()=>assert.fail('screening must not simulate executor'),estimateGas:()=>assert.fail('screening must not estimate executor gas')},converter:()=>({toNative:async x=>x}),calculateEconomics:async()=>({profitable:true,expectedNetProfit:bn(99)})});
  const result=await c.evaluate({borrowToken:A,legs:[{},{}]},100,{},block(1));
  assert.equal(quoted,1);assert.equal(result.economics.gasEstimation,'screening_heuristic');
});
test('selected route must pass measured executor gas, full calls and actual net profitability',async()=>{
  const f=fixture(),registry=new PoolRegistry(f.tokens);for(const p of f.pools)registry.add(p);
  const route=new CandidateIndex().candidates(registry,[A],1,new Set([P,Q]),1)[0];
  for(const profitable of [true,false]){
    let calls=0,estimates=0;const c=Object.create(Coordinator.prototype);
    const quote={route,borrowAmount:bn(100),expectedFinalAmount:bn(200),stateBlock:1,quotedAt:Date.now()};
    Object.assign(c,{state:new TradingStateMachine(),ledger:new TradeLedger({file:null}),overrides:{},operatorAddress:A,scanStats:{transactionCalls:0,gasEstimates:0},profile:{chainId:1,maxRouteHops:3,minimumRequiredProfit:'1',slippageBps:30,maxGasUnits:1500000,maxBuilderShareBps:1500,gasCeilingGwei:'50',maxQuoteAgeMs:10000,maxPoolStateAgeMs:10000,tokens:{WETH:B}},tokens:f.tokens,flashloan:{fee:()=>bn(1)},quoter:{quoteRoute:async()=>quote,buildData:()=>({})},contract:{address:a(99),interface:{encodeFunctionData:()=> '0x'},profitRecipient:async()=>B},provider:{call:async()=>{calls++;},estimateGas:async()=>{estimates++;return bn(100000);},getBlock:async()=>block(1)},converter:()=>({toNative:async x=>x}),refresh:async()=>route,calculateEconomics:async(_q,gas)=>({profitable,estimatedGasUnits:gas,expectedNetProfit:bn(99),minimumRequiredProfit:bn(1),estimatedGasCostBorrowToken:bn(5),estimatedBuilderPaymentBorrowToken:bn(1)})});
    c.state.paper();
    if(profitable){const prepared=await c.prepare({quote},{},block(1));assert.equal(prepared.transaction.gasLimit.toString(),'120000');assert.equal(prepared.economics.gasEstimation,'executor_estimate_with_margin');}
    else {await assert.rejects(c.prepare({quote},{},block(1)),/Net profit/);assert.equal(c.ledger.records.size,0);}
    assert.equal(calls,2);assert.equal(estimates,1);
  }
});
test('aborting during signer-balance validation prevents signing',async()=>{
  const f=fixture(),registry=new PoolRegistry(f.tokens);for(const p of f.pools)registry.add(p);
  const route=new CandidateIndex().candidates(registry,[A],1,new Set([P,Q]),1)[0];
  const state=new TradingStateMachine();state.paper();state.arm({ready:true});state.live();
  const controller=new AbortController();let signed=0;
  const engine=new ExecutionEngine({state,ledger:new TradeLedger({file:null}),profile:{chainId:1,maxRouteHops:3,maxGasUnits:1500000,maxQuoteAgeMs:10000,maxPoolStateAgeMs:10000,maxDailyLossNative:'0.1'},wallet:{address:A,signTransaction:async()=>{signed++;}},provider:{getBlock:async()=>block(1),getBalance:async()=>{controller.abort();return bn('1000000000000000000');}},contract:{paused:async()=>false}});
  await assert.rejects(engine.execute({block:block(1),quote:{route,stateBlock:1,quotedAt:Date.now()},economics:{profitable:true,estimatedGasUnits:bn(100000)},transaction:{gasLimit:bn(100000)},tip:{maxFeePerGas:bn(1)}},{signal:controller.signal,revision:state.revision}),{name:'AbortError'});
  assert.equal(signed,0);
});
