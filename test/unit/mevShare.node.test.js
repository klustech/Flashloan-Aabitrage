const test=require("node:test"),assert=require("node:assert/strict");
const {Wallet,utils,BigNumber}=require("ethers");
const {PrivateRelays}=require("../../server/execution/privateRelays");
const {BackrunExecutionEngine}=require("../../server/backrun/executionEngine");
const {parsePoolEffects}=require("../../server/backrun/mevShareHints");
const {TokenRegistry}=require("../../server/market/tokenRegistry");
const {PoolRegistry}=require("../../server/market/poolRegistry");

const auth=Wallet.createRandom(),hint="0x"+"ab".repeat(32);
const a=n=>"0x"+n.toString(16).padStart(40,"0");

test("mev_sendBundle references the hint hash, targets the next block only and is signed by the relay identity",async()=>{
  const relays=new PrivateRelays(null,[],undefined,{env:{RELAY_AUTH_PRIVATE_KEY:auth.privateKey}});
  const signed=await Wallet.createRandom().signTransaction({to:a(1),chainId:1,type:2,nonce:0,gasLimit:21000,maxFeePerGas:2,maxPriorityFeePerGas:1});
  let request;
  const fetchImpl=async(url,init)=>{request={url,...init};return {ok:true,status:200,json:async()=>({result:{bundleHash:"0xbb"}})};};
  const result=await relays.sendMevShareBundle({url:"https://relay.example",hash:hint,signedTx:signed,targetBlock:101,builders:["flashbots"],fetchImpl});
  assert.deepEqual(result,[{url:"https://relay.example",bundleHash:"0xbb",protocol:"mev_sendBundle"}]);
  const body=JSON.parse(request.body);
  assert.equal(body.method,"mev_sendBundle");
  assert.deepEqual(body.params[0],{version:"v0.1",inclusion:{block:"0x65",maxBlock:"0x65"},
    body:[{hash:hint},{tx:signed,canRevert:false}],privacy:{builders:["flashbots"]}});
  const [address,signature]=request.headers["X-Flashbots-Signature"].split(":");
  assert.equal(address,auth.address);
  assert.equal(utils.verifyMessage(utils.id(request.body),signature),auth.address);
  assert.equal(relays.status().relays["https://relay.example"].submissions,1);
});

test("mev_sendBundle fails closed on relay errors and malformed input",async()=>{
  const relays=new PrivateRelays(null,[],undefined,{env:{}});
  const ok=async()=>({ok:true,status:200,json:async()=>({error:{message:"bundle too old"}})});
  await assert.rejects(relays.sendMevShareBundle({url:"https://r",hash:hint,signedTx:"0x02",targetBlock:5,fetchImpl:ok}),/rejected/);
  await assert.rejects(relays.sendMevShareBundle({url:"https://r",hash:hint,signedTx:"0x02",targetBlock:5,fetchImpl:async()=>{throw new Error("ECONNRESET");}}),/unavailable/);
  await assert.rejects(relays.sendMevShareBundle({url:"https://r",hash:"0x1234",signedTx:"0x02",targetBlock:5,fetchImpl:ok}),/hash required/);
  await assert.rejects(relays.sendMevShareBundle({url:"https://r",hash:hint,signedTx:"nope",targetBlock:5,fetchImpl:ok}),/Signed raw/);
  const s=relays.status().relays["https://r"];
  assert.equal(s.submissionErrors,2);assert.equal(s.lastError,"ECONNRESET");
});

test("V3 swap logs give absolute post-trigger price, tick and liquidity",()=>{
  const tokens=new TokenRegistry(null,1);
  tokens.register({address:a(1),symbol:"A",decimals:18});tokens.register({address:a(2),symbol:"B",decimals:18});
  const registry=new PoolRegistry(tokens);
  registry.add({dex:"uniswap_v3",poolAddress:a(10),router:a(3),factory:a(4),quoter:a(5),token0:a(1),token1:a(2),feeTier:500,
    sqrtPriceX96:BigNumber.from(2).pow(96),liquidity:BigNumber.from(1)});
  const topic=utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
  const data=utils.defaultAbiCoder.encode(["int256","int256","uint160","uint128","int24"],[-5,7,123456,999,-887]);
  const [effect]=parsePoolEffects([{address:a(10),topics:[topic],data},{address:a(10),topics:[topic],data}],registry);
  assert.equal(effect.sqrtPriceX96.toString(),"123456");assert.equal(effect.tick,-887);assert.equal(effect.liquidity.toString(),"999");
  assert.equal(effect.delta0.toString(),"-10");assert.equal(effect.delta1.toString(),"14");
  assert.throws(()=>parsePoolEffects([{address:a(10),topics:[utils.id("Mint(address,address,int24,int24,uint128,uint256,uint256)")],data:"0x01"}],registry),/unsupported_pool_event/);
});

function prepared({kind="UNSIGNED_FORK_LOG_DERIVED_STATE",source="mev_share"}={}){
  const now=Date.now(),W=a(2),D=a(1);
  const leg=(tokenIn,tokenOut)=>({poolAddress:a(10),tokenIn,tokenOut,stateBlock:100,stateTimestamp:now,tokenInDecimals:18,tokenOutDecimals:18});
  const route={id:"r",chainId:1,borrowToken:W,legs:[leg(W,D),leg(D,W)]};
  return {executionId:"e1",trigger:{hash:hint,rawTx:null,source,receivedAt:now},block:{number:100,hash:"0xparent"},route,
    quote:{stateBlock:100,quotedAt:now,borrowAmount:BigNumber.from(10)},funding:{mode:"CAPITAL"},
    economics:{profitable:true,estimatedGasUnits:BigNumber.from(200000)},
    transaction:{to:a(9),data:"0x",gasLimit:BigNumber.from(200000),maxFeePerGas:BigNumber.from(2),maxPriorityFeePerGas:BigNumber.from(1)},
    tip:{maxFeePerGas:BigNumber.from(2)},simulation:{kind,simulatedAt:now}};
}
function engine(calls){
  const wallet=Wallet.createRandom(),records=[];
  const provider={getBlock:async()=>({hash:"0xparent",number:100}),getBalance:async()=>BigNumber.from(10).pow(20),
    getTransactionCount:async()=>0,getTransaction:async()=>{calls.lookups++;throw new Error("double hash looked up on chain");}};
  const profile={paperOnly:false,chainId:1,maxRouteHops:3,maxGasUnits:1000000,maxQuoteAgeMs:10000,maxPoolStateAgeMs:10000,
    maxDailyLossNative:"1",fingerprint:"f",tokens:{WETH:a(2)},
    backrun:{maxTriggerAgeMs:10000,maxSimulationAgeMs:10000,mevShareRelayUrl:"https://relay.example",mevShareBuilders:[]}};
  return new BackrunExecutionEngine({profile,wallet,provider,
    contract:{paused:async()=>false,profitRecipient:async()=>a(7)},
    state:{canSign:()=>true},tokens:{get:()=>({symbol:"WETH",decimals:18})},
    ledger:{pending:()=>[],dailyLossNative:()=>BigNumber.from(0),write:async r=>{records.push(r.status);calls.statuses=records;return r;}},
    readiness:async()=>({ready:true}),emit:()=>{},
    relays:{simulate:async()=>{calls.relaySim++;return [];},sendMevShareBundle:async args=>{calls.sent=args;return [{url:args.url,bundleHash:"0xbb"}];}}});
}

test("LIVE MEV-Share backrun is signed and sent via mev_sendBundle without on-chain trigger lookups or relay simulation",async()=>{
  const calls={lookups:0,relaySim:0},e=engine(calls),p=prepared();
  const result=await e.execute(p,{revision:1});
  assert.equal(result.status,"SUBMITTED");assert.equal(result.targetBlock,101);
  assert.equal(calls.sent.hash,hint);assert.equal(calls.sent.targetBlock,101);assert.equal(calls.sent.url,"https://relay.example");
  assert.equal(utils.keccak256(calls.sent.signedTx),result.txHash);
  assert.equal(calls.lookups,0);assert.equal(calls.relaySim,0);
  assert.deepEqual(calls.statuses,["DISCOVERED","SIMULATED","SUBMITTED","SUBMITTED"]);
});

test("LIVE MEV-Share execution refuses without a log-derived local simulation or outside MEV-Share",async()=>{
  for(const opts of [{kind:"UNSIGNED_FORK_BUNDLE"},{source:"public_pending"}]){
    const calls={lookups:0,relaySim:0},e=engine(calls);
    await assert.rejects(e.execute(prepared(opts),{revision:1}));
    assert.equal(e.activity.signatures,0);assert.equal(calls.sent,undefined);
  }
});
