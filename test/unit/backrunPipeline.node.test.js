const test=require("node:test"),assert=require("node:assert/strict"),fs=require("fs"),os=require("os"),path=require("path");
const {Wallet,utils}=require("ethers");
const {bn}=require("../../server/bot/units");
const {TokenRegistry}=require("../../server/market/tokenRegistry");
const {PoolRegistry}=require("../../server/market/poolRegistry");
const {decodeTriggerHint,decodeRouter,V2,V3,v3Path}=require("../../server/backrun/triggerDecoder");
const {AffectedPoolResolver}=require("../../server/backrun/affectedPoolResolver");
const {PostTriggerQuoter}=require("../../server/backrun/postTriggerQuoter");
const {FundingEngine}=require("../../server/backrun/fundingEngine");
const {validateRaw,rawTransaction}=require("../../server/backrun/rawTransaction");
const {ForkBackend,assertLocalForkUrl,nextBaseFee}=require("../../server/backrun/forkBackend");
const {BackrunLedger}=require("../../server/backrun/backrunLedger");
const {BackrunEvidence}=require("../../server/backrun/evidence");
const {HistoricalReplay,verifyReceipts}=require("../../server/backrun/historicalReplay");
const {HistoricalBenchmark}=require("../../server/backrun/benchmark");
const {evidenceFingerprint,commissioningChecks}=require("../../server/backrun/readiness");
const {BackrunExecutionEngine}=require("../../server/backrun/executionEngine");
const {validateBackrunBundleSimulation}=require("../../server/execution/flashbots");
const {smoke}=require("../../scripts/backrun-smoke");
const a=n=>"0x"+n.toString(16).padStart(40,"0"),hash=n=>"0x"+n.toString(16).padStart(64,"0");
const W=a(1),D=a(2),U=a(3),R=a(4),F=a(5),P=a(6),Q=a(7);
function universe(){
  const tokens=new TokenRegistry(null,1);
  for(const [address,symbol,decimals] of [[W,"WETH",18],[D,"DAI",18],[U,"USDC",6]])tokens.register({address,symbol,decimals});
  const registry=new PoolRegistry(tokens);
  for(const [poolAddress,r0] of [[P,1000],[Q,1100]])registry.add({dex:"uniswap_v2",poolAddress,router:R,factory:F,token0:W,token1:D,reserve0:bn(r0),reserve1:bn(1000),feeBps:30});
  return {tokens,registry};
}
function profile(){return {tokens:{WETH:W,DAI:D,USDC:U},chainId:1,fingerprint:"test",backrun:{
  enabled:true,borrowSymbols:["WETH","DAI","USDC"],fundingMode:"adaptive",capitalReserveBps:1000,
  minimumProfitBySymbol:{WETH:"1"},maxAmountBySymbol:{WETH:"1000"},latencyBudgetMs:2500,commissioningPath:"absent"}};}
test("router decoder binds calldata to tracked router/pool and rejects ambiguous parallel V2 pools",()=>{
  const {registry}=universe();
  const tx={to:R,data:V2.encodeFunctionData("swapExactTokensForTokens",[100,1,[W,D],a(99),999])};
  assert.throws(()=>decodeRouter(tx,registry),/ambiguous/);
  registry.pools.delete("1:uniswap_v2:"+Q);
  const decoded=decodeRouter(tx,registry);
  assert.equal(decoded[0].poolAddress,P);assert.equal(decoded[0].amountIn.toString(),"100");
  assert.deepEqual(decodeRouter({...tx,to:a(77)},registry),[]);
  assert.equal(decodeTriggerHint({...tx,hash:hash(1)},registry).decodingMethod,"router_calldata");
});
test("V3 decoding preserves exact-output path direction and fee-specific pool identity",()=>{
  const {tokens}=universe(),registry=new PoolRegistry(tokens);
  registry.add({dex:"uniswap_v3",poolAddress:P,router:R,factory:F,quoter:a(8),token0:W,token1:D,feeTier:500,sqrtPriceX96:bn(2).pow(96),liquidity:bn(1000)});
  const pathBytes=utils.solidityPack(["address","uint24","address"],[D,500,W]);
  assert.deepEqual(v3Path(pathBytes,true),{tokens:[W,D],fees:[500]});
  const data=V3.encodeFunctionData("exactOutput",[{path:pathBytes,recipient:a(9),deadline:999,amountOut:20,amountInMaximum:30}]);
  const swap=decodeRouter({to:R,data},registry)[0];
  assert.equal(swap.tokenIn,W);assert.equal(swap.exactOutput,true);assert.equal(swap.poolAddress,P);
  assert.throws(()=>v3Path("0x1234"),/Invalid/);
});
test("signed-envelope recovery validates trigger hash, chain and cannot invent missing signatures",async()=>{
  const wallet=Wallet.createRandom(),raw=await wallet.signTransaction({to:R,nonce:0,chainId:1,gasLimit:21000,gasPrice:1,value:0});
  assert.equal(validateRaw(raw,utils.keccak256(raw)).from,wallet.address.toLowerCase());
  assert.throws(()=>validateRaw(raw,hash(2)),/mismatch/);
  const wrong=await wallet.signTransaction({to:R,nonce:0,chainId:1337,gasLimit:21000,gasPrice:1});
  assert.throws(()=>validateRaw(wrong,utils.keccak256(wrong)),/mainnet/);
  const parsed=utils.parseTransaction(raw);
  assert.equal(await rawTransaction({send:async()=>{throw new Error("unsupported");}},parsed),raw);
  await assert.rejects(rawTransaction({send:async()=>null},{hash:hash(1),type:2}),/unavailable/);
});
test("type-4 signed raw envelopes retain authorization lists and recover the original signer",()=>{
  const wallet=Wallet.createRandom();
  const fields=["0x01","0x","0x01","0x02","0x5208",R,"0x","0x",[],[]];
  const digest=utils.keccak256(utils.hexConcat(["0x04",utils.RLP.encode(fields)])),signature=wallet._signingKey().signDigest(digest);
  const parity=signature.recoveryParam?"0x01":"0x";
  const raw=utils.hexConcat(["0x04",utils.RLP.encode([...fields,parity,signature.r,signature.s])]);
  assert.equal(validateRaw(raw,utils.keccak256(raw)).from,wallet.address.toLowerCase());
});
test("fork backend rejects remote/mainnet endpoints and correctly predicts EIP-1559 base fee",async()=>{
  assert.throws(()=>assertLocalForkUrl("https://eth-mainnet.example"),/loopback/);
  assert.equal(nextBaseFee({baseFeePerGas:bn(100),gasLimit:bn(100),gasUsed:bn(100)}).toString(),"112");
  assert.equal(nextBaseFee({baseFeePerGas:bn(100),gasLimit:bn(100),gasUsed:bn(0)}).toString(),"88");
  const backend=new ForkBackend({url:"http://127.0.0.1:8547",provider:{send:async method=>method==="web3_clientVersion"?"geth":"0x1"}});
  await assert.rejects(backend.verify(),/Hardhat/);
});
test("fork mutations are serialized and an aborted queued job never begins",async()=>{
  const backend=new ForkBackend({url:"http://127.0.0.1:8547",provider:{}});
  let release;const gate=new Promise(r=>release=r),events=[],controller=new AbortController();
  const one=backend.exclusive(async()=>{events.push("one");await gate;events.push("done");});
  const two=backend.exclusive(async()=>{events.push("two");},controller.signal);
  controller.abort();release();await one;await assert.rejects(two,/Abort|abort/i);
  assert.deepEqual(events,["one","done"]);
});
test("affected-route index reuses topology, preserves parallel edges and restricts repricing",()=>{
  const {registry}=universe(),resolver=new AffectedPoolResolver({profile:profile()});
  const routes=resolver.resolve(registry,[P],1);
  assert.ok(routes.length);assert.ok(routes.every(r=>r.legs.some(l=>l.poolAddress===P)));
  assert.equal(routes[0].borrowToken,W);
  resolver.resolve(registry,[Q],2);assert.equal(resolver.index.stats.rebuilds,1);
});
test("post-trigger quoting refuses mixed state and expired contexts",async()=>{
  let calls=0;
  const context={id:"overlay",active:true,parentBlock:9,simulationBlock:10,triggerHash:hash(1),parentHash:hash(2),
    assertActive(){if(!this.active)throw new Error("expired");},
    quoter:{quoteRoute:async()=>{calls++;return {stateBlock:10,expectedFinalAmount:bn(20)};}}};
  const quoter=new PostTriggerQuoter(context,profile());
  await assert.rejects(quoter.quote({legs:[{predictionContext:"base"}]},1),/Mixed/);
  const quote=await quoter.quote({legs:[{predictionContext:"overlay"}]},1);
  assert.equal(quote.stateBlock,9);assert.equal(quote.simulatedAtBlock,10);assert.equal(calls,1);
  context.active=false;await assert.rejects(quoter.quote({legs:[]},1),/expired/);
});
test("funding rejects fee-erased profit, unknown premium, oversizing and negative costs",async()=>{
  const p=profile(),engine=new FundingEngine({profile:p,tokens:{get:()=>({symbol:"WETH"}),parse:(_t,n)=>bn(n)},
    flashloan:{fee:(n,bps)=>bn(n).mul(bps).div(10000)},contract:{},provider:{}});
  engine.capitalAvailable=async()=>bn(0);
  const request={token:W,amount:bn(1000),grossProfit:bn(2),gasCostBorrowToken:bn(1),terms:{premiumBps:20,availableLiquidity:bn(5000)},blockTag:1};
  assert.equal((await engine.decide(request)).mode,"REJECT");
  assert.equal((await engine.decide({...request,grossProfit:bn(100),terms:{availableLiquidity:bn(5000)}})).mode,"REJECT");
  assert.equal((await engine.decide({...request,amount:bn(1001)})).reason,"amount_exceeds_backrun_limit");
  await assert.rejects(engine.decide({...request,gasCostBorrowToken:-1}),/Invalid/);
});
test("backrun journal survives restart, strips raw flow and fails closed on invalid transitions",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"backrun-ledger-")),file=path.join(dir,"records.jsonl");
  try{
    let persisted=0;const ledger=new BackrunLedger({file,persist:async()=>persisted++});
    const row={id:"one",triggerHash:hash(1),triggerSource:"custom",mode:"PAPER",status:"DETECTED",rawTx:"secret"};
    await ledger.write(row);await ledger.write({...row,status:"POST_TRIGGER_QUOTED",inputAmount:"123456789012345678901234567890"});
    await assert.rejects(ledger.write({...row,status:"SUBMITTED"}),/lifecycle/);
    const restarted=new BackrunLedger({file});
    assert.equal(restarted.recent()[0].inputAmount,"123456789012345678901234567890");
    assert.equal(restarted.recent()[0].rawTx,undefined);assert.equal(persisted,2);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("paper evidence rejects gaps and signing, and changes in risk settings invalidate it",()=>{
  let now=100000,profileValue=profile(),evidence=new BackrunEvidence(profileValue,{file:null,now:()=>now});
  evidence.heartbeat({healthy:true,paper:true});
  evidence.record({mode:"PAPER",status:"SIMULATED",triggerHash:hash(1),simulation:{ordered:true,signed:false,submitted:false},economics:{profitable:true}});
  assert.equal(evidence.report().profitable,1);
  now+=31000;evidence.heartbeat({healthy:true,paper:true});assert.equal(evidence.report().profitable,0);assert.equal(evidence.report().continuousMs,0);
  evidence.heartbeat({healthy:true,paper:true,signatures:1});assert.equal(evidence.report().passed,false);
  assert.equal(evidenceFingerprint({...profileValue,paperOnly:true}),evidenceFingerprint({...profileValue,paperOnly:false}));
  assert.notEqual(evidenceFingerprint(profileValue),evidenceFingerprint({...profileValue,backrun:{...profileValue.backrun,capitalReserveBps:500}}));
  assert.equal(commissioningChecks(profileValue,{}).ready,false);
});
test("historical receipts prove exact order, status, gas and pool logs",()=>{
  const receipt={transactionHash:hash(1),transactionIndex:0,status:1,gasUsed:bn(100),logs:[{address:P,topics:[hash(2)],data:"0x"}]};
  verifyReceipts([receipt],[receipt]);
  assert.throws(()=>verifyReceipts([{...receipt,status:0}],[receipt]),/mismatch/);
  assert.throws(()=>verifyReceipts([{...receipt,gasUsed:bn(99)}],[receipt]),/mismatch/);
  assert.throws(()=>verifyReceipts([{...receipt,logs:[]}],[receipt]),/mismatch/);
});
test("intra-block proof checks all four states and does not presume transaction 143 created the edge",async()=>{
  const fixture={name:"test",targetBlock:10,triggerTransactionIndex:1,arbitrageTransactionIndex:2,triggerTransaction:hash(2),
    arbitrageTransaction:hash(3),amountIn:"100000",actualFinalAmount:"100100",preBlockExpectedFinalAmount:"99900"};
  const replay=new HistoricalReplay({}),data={block:{number:10,hash:hash(9),transactions:[{hash:hash(1)},{hash:hash(2)},{hash:hash(3)}]},parent:{hash:hash(8)}};
  replay.block=async()=>data;let before="99999";
  replay.prefix=async(_d,n)=>({[-1]:"99900",0:before,1:"100100",2:"100001"})[n];
  assert.equal((await replay.caseStudy(fixture,()=>{})).passed,true);
  before="100010";assert.equal((await replay.caseStudy(fixture,()=>{})).passed,false);
});
test("historical benchmark requires complete seven-day coverage and separates token/funding economics",()=>{
  const benchmark=new HistoricalBenchmark(profile());benchmark.blocks.add(1);
  assert.throws(()=>benchmark.record({}),/evidence/);
  const report=benchmark.report({startBlock:1,endBlock:2,startedTimestamp:0,endedTimestamp:7*86400,
    complete:true,evaluatedTriggers:1,totalTrackedTriggers:2});
  assert.equal(report.coverageComplete,false);assert.equal(report.passed,false);assert.equal(report.netIsUpperBound,true);
});
test("PAPER_ONLY blocks dedicated backrun execution before any signer, relay or provider call",async()=>{
  let calls=0;
  const engine=new BackrunExecutionEngine({profile:{paperOnly:true},wallet:{signTransaction:async()=>calls++},relays:{simulate:async()=>calls++}});
  await assert.rejects(engine.execute({},{}),/PAPER_ONLY/);assert.equal(calls,0);assert.equal(engine.activity.signatures,0);
});
test("commissioning requires matching full evidence, recent unsigned PAPER and explicit economic acceptance",()=>{
  const {buildReport}=require("../../scripts/backrun-commissioning-report");
  const p=profile(),now=Date.now(),fingerprint=evidenceFingerprint(p),proof={passed:true,profileFingerprint:fingerprint};
  const evidence={
    replay:{...proof,intraBlock:true,canonicalReceiptsVerified:true},
    benchmark:{...proof,durationMs:7*86400000,coverageComplete:true,sameBlockBundleVerified:true,
      distinctProfitableTriggers:3,fullExecutorSimulations:true,latency:{p95Ms:1000},opportunityFrequencyPerDay:3,netNative:"700"},
    paper:{...proof,continuousMs:7*86400000,profitable:3,signatures:0,submissions:0,lastHeartbeat:now},
    capitalForkProof:{...proof,mode:"CAPITAL",executorVersion:3},flashForkProof:{...proof,mode:"FLASH_LOAN",executorVersion:3},
    riskReview:{reviewed:true,profileFingerprint:fingerprint,minimumOpportunitiesPerDay:2,minimumNetNativePerDay:"50",
      capitalPlan:"bounded",drawdownPlan:"stop",competitionAssumptions:"reviewed"}
  };
  assert.equal(buildReport(p,evidence,now).passed,true);
  for(const changed of [
    {...evidence,replay:{...evidence.replay,canonicalReceiptsVerified:false}},
    {...evidence,paper:{...evidence.paper,signatures:1}},
    {...evidence,paper:{...evidence.paper,lastHeartbeat:now-31000}},
    {...evidence,flashForkProof:{...evidence.flashForkProof,profileFingerprint:"other"}},
    {...evidence,benchmark:{...evidence.benchmark,netNative:"1"}},
    {...evidence,riskReview:{...evidence.riskReview,reviewed:false}}
  ])assert.equal(buildReport(p,changed,now).passed,false);
});
test("ordered relay validation rejects trigger/backrun failure, missing direct-payment evidence and extra results",()=>{
  const triggerRaw="0x01",backrunRaw="0x02",opts={triggerRawTx:triggerRaw,backrunSignedTx:backrunRaw,stateBlock:1,maxGasUnits:bn(100)};
  const result={stateBlockNumber:1,totalGasUsed:"110",results:[{txHash:utils.keccak256(triggerRaw),gasUsed:"10"},
    {txHash:utils.keccak256(backrunRaw),gasUsed:"100",ethSentToCoinbase:"0"}]};
  assert.equal(validateBackrunBundleSimulation(result,opts).gasUsed.toString(),"100");
  assert.throws(()=>validateBackrunBundleSimulation({...result,results:[{...result.results[0],revert:"revert"},result.results[1]]},opts),/Trigger/);
  assert.throws(()=>validateBackrunBundleSimulation({...result,results:[result.results[0],{...result.results[1],ethSentToCoinbase:undefined}]},opts),/coinbase/);
  assert.throws(()=>validateBackrunBundleSimulation({...result,results:[...result.results,result.results[1]]},opts),/missing/);
});
test("backrun smoke is read-only, requires advancing real API counters and fails on signing",async()=>{
  let now=0,round=0,signatures=0;
  const request={baseUrl:"http://127.0.0.1:3001",apiKey:"key",now:()=>now,wait:async()=>{now+=1000;round++;},
    fetch:async(url,options)=>{
      assert.equal(options.method,undefined);assert.equal(options.headers["x-api-key"],"key");
      const path=url.pathname,data=path==="/api/trading"?{trading:{state:"PAPER"},safety:{paperOnly:true,hasPrivateKey:false,activity:{signatures,submissions:0}}}:
        path==="/api/backrun/status"?{enabled:true,running:true,source:{connected:true},activity:{signatures:0,submissions:0},received:round,profitable:0}:
        {database:true,runtimeWritable:true,chainId:1,block:10+round};
      return {ok:true,json:async()=>data};
    }};
  assert.equal((await smoke(request)).passed,true);
  signatures=1;await assert.rejects(smoke(request),/invariants/);
});
