const test=require("node:test"),assert=require("node:assert/strict");
const {bn}=require("../../server/bot/units");
const {BackrunService}=require("../../server/backrun/service");
const {BackrunLedger}=require("../../server/backrun/backrunLedger");
const a=n=>"0x"+n.toString(16).padStart(40,"0"),h=n=>"0x"+n.toString(16).padStart(64,"0");
function fixture(){
  const profile={paperOnly:true,expectedProfitRecipient:a(9),backrun:{enabled:true,maxPending:2,maxTriggerAgeMs:8000,simulationTimeoutMs:8000,orderflowSource:"custom"}};
  let signCalls=0,evidenceRows=0,inspectCalls=0;
  const block={number:1,hash:h(1)},coordinator={profile,state:{state:"PAPER",revision:1,snapshot:()=>({state:"PAPER",mode:"PAPER"})},
    provider:{getBlock:async()=>block,getTransaction:async()=>({blockNumber:null})},marketCache:{head:block},
    poolRegistry:{values:()=>[{poolAddress:a(6)}]},ledger:{pending:()=>[]},tokens:{get:()=>({symbol:"WETH",decimals:18})},
    execution:{activity:{signatures:0,submissions:0}},contract:{address:a(8),interface:{parseLog:()=>({name:"ProfitWithdrawn",args:{token:a(1),recipient:a(9),amount:bn(30)}})}}};
  const execution={activity:{signatures:0,submissions:0},execute:async()=>{signCalls++;throw new Error("should not execute");}};
  const ledger=new BackrunLedger({file:null});
  const engine={status:()=>({}),inspect:async(_args,consume)=>{
    inspectCalls++;
    const route={id:"route",borrowToken:a(1),legs:[{dex:"uniswap_v2",poolAddress:a(6)},{dex:"sushiswap_v2",poolAddress:a(7)}]};
    return consume({opportunities:[{route,quote:{borrowAmount:bn(100)},grossProfit:bn(30),funding:{mode:"CAPITAL",flashFee:bn(0),capitalAvailable:bn(100)},
      economics:{profitable:true,minimumRequiredProfit:bn(5),expectedNetProfit:bn(10)},costBudgetBorrow:bn(10),transaction:{gasLimit:bn(100000)},tip:{builderPaymentNativeWei:bn(0)}}],
      rejections:[],context:{id:"context",predictionMs:0,changedPools:new Set([a(6)]),header:{number:2}},stages:{predictionMs:0}});
  }};
  const backend={simulateUnsignedBundle:async()=>({kind:"UNSIGNED_FORK_BUNDLE",gasUsed:bn(100000),triggerGasUsed:bn(21000),parentHash:h(1),
    simulatedAt:Date.now(),backrunReceipt:{logs:[{address:a(8)}]}})};
  const service=new BackrunService({coordinator,engine,backend,execution,ledger,
    source:{status:()=>({connected:true}),stop(){},removeListener(){}},
    evidence:{record:()=>evidenceRows++,report:()=>({passed:false})}});
  service.closed=false;
  return {service,coordinator,ledger,counters:()=>({signCalls,evidenceRows,inspectCalls})};
}
test("PAPER pipeline persists all stages and verifies settlement without invoking execution",async()=>{
  const {service,ledger,counters}=fixture(),trigger={hash:h(2),rawTx:"fixture",source:"custom",receivedAt:Date.now()};
  const row=await ledger.write({id:"one",triggerHash:trigger.hash,triggerSource:trigger.source,status:"DETECTED",mode:"PAPER"});
  await service.process({trigger,row});
  assert.equal(ledger.recent()[0].status,"SIMULATED");assert.equal(ledger.recent()[0].simulation.signed,false);
  assert.deepEqual(counters(),{signCalls:0,evidenceRows:1,inspectCalls:1});assert.equal(service.stats.profitable,1);
});
test("stale triggers are rejected before post-state work; parent changes invalidate simulation",async()=>{
  let f=fixture(),trigger={hash:h(2),source:"custom",receivedAt:Date.now()-9000};
  let row=await f.ledger.write({id:"one",triggerHash:trigger.hash,triggerSource:"custom",status:"DETECTED",mode:"PAPER"});
  await f.service.process({trigger,row});
  assert.equal(f.counters().inspectCalls,0);assert.match(f.ledger.recent()[0].rejectionReason,/expired/);
  f=fixture();trigger={...trigger,receivedAt:Date.now()};let calls=0;
  f.coordinator.provider.getBlock=async()=>({number:1,hash:++calls===1?h(1):h(9)});
  row=await f.ledger.write({id:"two",triggerHash:trigger.hash,triggerSource:"custom",status:"DETECTED",mode:"PAPER"});
  await f.service.process({trigger,row});assert.equal(f.ledger.recent()[0].status,"REJECTED");
  assert.equal(f.counters().signCalls,0);assert.match(f.ledger.recent()[0].rejectionReason,/parent/);
});
