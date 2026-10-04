const test=require("node:test");
const assert=require("node:assert/strict");
const { BigNumber }=require("ethers");
const { FundingEngine }=require("../../server/backrun/fundingEngine");
const { TriggerStatePredictor }=require("../../server/backrun/statePredictor");
const { StateOverrideProvider }=require("../../server/backrun/stateOverrideProvider");
const { BackrunScheduler }=require("../../server/backrun/backrunScheduler");
const { MevShareClient }=require("../../server/backrun/mevShareClient");
const { productionProfile }=require("../../server/config/productionProfile");

const A="0x0000000000000000000000000000000000000001";
const B="0x0000000000000000000000000000000000000002";

test("adaptive funding keeps thin treasury opportunity that Aave premium would kill",()=>{
  const engine=new FundingEngine();
  const amount=BigNumber.from(100000);
  const result=engine.choose({
    borrowAmount:amount,
    expectedFinalAmount:BigNumber.from(100130),
    treasuryBalance:amount,
    flashLiquidity:amount.mul(10),
    flashPremiumBps:9,
    gasCostByMode:{TREASURY:30,AAVE_FLASH_LOAN:30},
    builderPaymentByMode:{TREASURY:10,AAVE_FLASH_LOAN:10},
    minimumRequiredProfit:50,
  });
  assert.equal(result.mode,"TREASURY");
  assert.equal(result.profitable,true);
  const flash=result.options.find(x=>x.mode==="AAVE_FLASH_LOAN");
  assert.equal(flash.profitable,false);
});

test("state predictor converts prestateTracer diff into post-trigger overrides and affected pools",async()=>{
  const calls=[];
  const provider={send:async(method,params)=>{calls.push([method,params]);return {
    post:{
      [A]:{storage:{"0x01":"0x02"},balance:"0x10"},
      [B]:{storage:{"0x03":"0x04"}},
    },
  };}};
  const predictor=new TriggerStatePredictor(provider,{timeoutMs:1000});
  const result=await predictor.predict({
    tx:{from:B,to:A,data:"0x12345678",value:0},
    logs:[{address:A}],
  },100,[A]);
  assert.equal(result.supported,true);
  assert.deepEqual(result.affectedPools,[A.toLowerCase()]);
  assert.equal(result.stateOverrides[A.toLowerCase()].stateDiff["0x01"],"0x02");
  assert.equal(calls[0][0],"debug_traceCall");
  assert.equal(calls[0][1][1],"0x64");
});

test("state override provider attaches predicted state to eth_call",async()=>{
  const calls=[];
  const base={
    _isProvider:true,
    send:async(method,params)=>{calls.push([method,params]);return "0x1234";},
    getNetwork:async()=>({chainId:1}),
    resolveName:async x=>x,
  };
  const overlay=new StateOverrideProvider(base,{blockTag:100,stateOverrides:{[A]:{stateDiff:{"0x01":"0x02"}}}});
  const result=await overlay.call({to:A,data:"0x"});
  assert.equal(result,"0x1234");
  assert.equal(calls[0][0],"eth_call");
  assert.equal(calls[0][1][1],"0x64");
  assert.ok(calls[0][1][2][A]);
});

test("backrun scheduler deduplicates trigger hashes and never overlaps work",async()=>{
  let active=0,maxActive=0;
  const seen=[];
  let release;
  const first=new Promise(resolve=>{release=resolve;});
  const scheduler=new BackrunScheduler({
    enabled:()=>true,
    budgetMs:()=>1000,
    eventTtlMs:()=>10000,
    run:async({trigger,signal})=>{
      active++;maxActive=Math.max(maxActive,active);seen.push(trigger.hash);
      if(trigger.hash==="0x1")await Promise.race([
        first,
        new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true})),
      ]);
      active--;
    },
  }).start();
  scheduler.enqueue({hash:"0x1",receivedAt:Date.now()});
  scheduler.enqueue({hash:"0x1",receivedAt:Date.now()});
  scheduler.enqueue({hash:"0x2",receivedAt:Date.now()});
  release();
  await new Promise(resolve=>setTimeout(resolve,25));
  scheduler.stop();
  assert.equal(scheduler.stats.deduplicated,1);
  assert.equal(maxActive,1);
  assert.ok(seen.includes("0x2"));
});

test("MEV-Share bundle contains one trigger reference and exactly one backrun transaction",()=>{
  const client=new MevShareClient({authSigner:{address:A,signMessage:async()=> "0x00"}});
  const bundle=client.buildBundle({
    triggerHash:"0x"+"11".repeat(32),
    signedBackrun:"0x1234",
    targetBlock:101,
  });
  assert.equal(bundle.body.length,2);
  assert.ok(bundle.body[0].hash);
  assert.deepEqual(bundle.body[1],{tx:"0x1234",canRevert:false});
});

test("production backrun profile is WETH-first without changing legacy block defaults",()=>{
  const backrun=productionProfile({
    PAPER_ONLY:"true",
    PRIVATE_KEY:"",
    OPPORTUNITY_MODE:"backrun",
  });
  assert.equal(backrun.opportunityMode,"backrun");
  assert.deepEqual(backrun.backrunBorrowSymbols,["WETH","DAI","USDC"]);
  assert.equal(backrun.backrunLimits.WETH.minBorrow,"0.01");
  assert.equal(backrun.backrun.enabled,true);
  const legacy=productionProfile({PAPER_ONLY:"true",PRIVATE_KEY:""});
  assert.deepEqual(legacy.borrowSymbols,["DAI"]);
  assert.equal(legacy.opportunityMode,"block");
});
