const test=require('node:test');
const assert=require('node:assert/strict');
const {bn}=require('../../server/bot/units');
const {TokenRegistry}=require('../../server/market/tokenRegistry');
const {PoolRegistry}=require('../../server/market/poolRegistry');
const {BackrunEngine}=require('../../server/backrun/backrunEngine');
const {TriggerIntake}=require('../../server/backrun/triggerIntake');
const {buildBackrunBundlePlan}=require('../../server/backrun/bundlePlan');
const {FundingEngine}=require('../../server/backrun/fundingEngine');
const {decodeTriggerHint}=require('../../server/backrun/triggerDecoder');
const {utils}=require('ethers');
const {validateBackrunBundleSimulation}=require('../../server/execution/flashbots');
const {MevShareSource}=require('../../server/backrun/mevShareSource');
const {encodeExecutorCall}=require('../../server/backrun/executorTransaction');

const a=n=>`0x${n.toString(16).padStart(40,'0')}`;
const DAI=a(1),WETH=a(2),USDC=a(3),R=a(4),F=a(5),P=a(10),Q=a(11);

function registry(){
  const tokens=new TokenRegistry(null,1);
  tokens.register({address:DAI,symbol:'DAI',decimals:18});
  tokens.register({address:WETH,symbol:'WETH',decimals:18});
  tokens.register({address:USDC,symbol:'USDC',decimals:6});
  const r=new PoolRegistry(tokens);
  for(const [poolAddress,reserve0,reserve1] of [[P,1000,1000],[Q,1100,1000]])
    r.add({dex:'uniswap_v2',poolAddress,router:R,factory:F,token0:WETH,token1:DAI,reserve0:bn(reserve0),reserve1:bn(reserve1),feeBps:30});
  return {tokens,r};
}

test('trigger intake deduplicates and bounds pending work',()=>{
  const intake=new TriggerIntake({maxPending:2});
  assert.equal(intake.push({hash:'0x01',affectedPools:[P,P]}),true);
  assert.equal(intake.push({hash:'0x01',affectedPools:[P]}),false);
  intake.push({hash:'0x02',affectedPools:[Q]});
  intake.push({hash:'0x03',affectedPools:[P]});
  assert.equal(intake.snapshot().pending,2);
  assert.equal(intake.snapshot().duplicate,1);
  assert.equal(intake.snapshot().dropped,1);
});

test('backrun engine only reprices routes touching the trigger and prioritizes WETH',async()=>{
  const {r}=registry();
  const profile={tokens:{WETH,DAI,USDC},backrun:{borrowSymbols:['WETH','DAI','USDC']}};
  const fundingEngine={decide:async()=>({mode:'CAPITAL',expectedNetProfit:bn(10)})};
  const seen=[];
  const engine=new BackrunEngine({profile,fundingEngine,evaluatePostTrigger:async({route})=>{seen.push(route);return {borrowAmount:bn(100),grossProfit:bn(20),gasCostBorrowToken:bn(1),builderPaymentBorrowToken:bn(1),flashloanTerms:{premiumBps:9,availableLiquidity:bn(1000)}};}});
  const out=await engine.inspect({trigger:{hash:'0xabc',affectedPools:[P]},registry:r,block:{number:1}});
  assert.ok(out.length>=1);
  assert.ok(seen.every(route=>route.legs.some(leg=>leg.poolAddress===P)));
  assert.equal(out[0].route.borrowToken,WETH);
});

test('adaptive funding prefers owned capital and falls back to flash liquidity',async()=>{
  const tokens={parse:(_token,value)=>bn(value),get:()=>({symbol:'WETH'})};
  const flashloan={fee:(amount,bps)=>bn(amount).mul(bps).div(10000)};
  const profile={minimumRequiredProfit:'5',backrun:{fundingMode:'adaptive',capitalReserveBps:0,minimumProfitBySymbol:{WETH:'5'},maxAmountBySymbol:{WETH:'500'}}};
  let capital=bn(1000);
  const provider={};
  class FakeContract{constructor(){this.address=a(99);}}
  const old=require('ethers').Contract;
  // FundingEngine obtains ERC20 balance through ethers.Contract, so override the
  // method in this focused unit by replacing capitalAvailable directly.
  const engine=new FundingEngine({provider,contract:new FakeContract(),tokens,flashloan,profile});
  engine.capitalAvailable=async()=>capital;
  let decision=await engine.decide({token:WETH,amount:bn(100),grossProfit:bn(30),gasCostBorrowToken:bn(10),builderPaymentBorrowToken:bn(2),terms:{premiumBps:9,availableLiquidity:bn(1000)},blockTag:1});
  assert.equal(decision.mode,'CAPITAL');
  capital=bn(0);
  decision=await engine.decide({token:WETH,amount:bn(100),grossProfit:bn(30),gasCostBorrowToken:bn(10),builderPaymentBorrowToken:bn(2),terms:{premiumBps:9,availableLiquidity:bn(1000)},blockTag:1});
  assert.equal(decision.mode,'FLASH_LOAN');
  void old;
});

test('bundle plan is unsigned in PAPER and requires trigger+backrun raw transactions in LIVE',()=>{
  const paper=buildBackrunBundlePlan({trigger:{hash:'0xabc'},backrunTransaction:{to:a(9)},stateBlock:1,targetBlock:2,funding:{mode:'CAPITAL'},paperOnly:true});
  assert.equal(paper.signedBundle,null);
  assert.throws(()=>buildBackrunBundlePlan({trigger:{hash:'0xabc'},backrunTransaction:{},stateBlock:1,targetBlock:2,funding:{mode:'CAPITAL'},paperOnly:false}),/raw trigger/);
  const triggerRaw='0x01';
  const live=buildBackrunBundlePlan({trigger:{hash:utils.keccak256(triggerRaw),rawTx:triggerRaw},backrunTransaction:{signedTx:'0x02'},stateBlock:1,targetBlock:2,funding:{mode:'CAPITAL'},paperOnly:false});
  assert.deepEqual(live.signedBundle,[triggerRaw,'0x02']);
});


test('trigger decoder accepts only tracked swap-log hints',()=>{
  const {r}=registry();
  const topic=utils.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
  const decoded=decodeTriggerHint({hash:'0xabc',logs:[
    {address:P,topics:[topic]},
    {address:a(999),topics:[topic]},
    {address:Q,topics:['0x'+'00'.repeat(32)]},
  ]},r);
  assert.equal(decoded.usable,true);
  assert.deepEqual(decoded.affectedPools,[P]);
});

test('backrun bundle validation charges only our transaction gas and verifies order',()=>{
  const triggerRaw='0x01',backrunRaw='0x02';
  const simulation={
    stateBlockNumber:7,
    results:[
      {txHash:utils.keccak256(triggerRaw),gasUsed:'100000'},
      {txHash:utils.keccak256(backrunRaw),gasUsed:'150000',ethSentToCoinbase:'0'}
    ],
    totalGasUsed:'250000'
  };
  const out=validateBackrunBundleSimulation(simulation,{triggerRawTx:triggerRaw,backrunSignedTx:backrunRaw,stateBlock:7,maxGasUnits:bn(200000)});
  assert.equal(out.gasUsed.toString(),'150000');
  assert.equal(out.triggerGasUsed.toString(),'100000');
  assert.throws(()=>validateBackrunBundleSimulation({...simulation,results:[simulation.results[1],simulation.results[0]]},{triggerRawTx:triggerRaw,backrunSignedTx:backrunRaw,stateBlock:7,maxGasUnits:bn(200000)}),/Trigger transaction/);
});


test('MEV-Share source normalizes SSE hints without signing or submission',()=>{
  const source=new MevShareSource();
  let hint=null,errors=0;
  source.on('hint',x=>hint=x);
  source.on('source_error',()=>errors++);
  const topic=utils.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
  source.handleEvent('data: '+JSON.stringify({hash:'0xABC',logs:[{address:P,topics:[topic]}],txs:[{to:R,functionSelector:'0x12345678'}]})+'\n');
  assert.equal(hint.hash,'0xabc');
  assert.equal(hint.source,'mev_share');
  assert.equal(hint.logs.length,1);
  assert.equal(source.status().events,1);
  source.handleEvent('data: {bad json}\n');
  assert.equal(source.status().parseErrors,1);
  assert.equal(errors,1);
});


test('executor transaction builder selects capital and flashloan entrypoints',()=>{
  const calls=[];
  const contract={interface:{encodeFunctionData:(name,args)=>{calls.push([name,args]);return '0x1234';}}};
  assert.equal(encodeExecutorCall(contract,{x:1},'CAPITAL'),'0x1234');
  assert.equal(calls.at(-1)[0],'executeCapitalArbitrage');
  assert.equal(encodeExecutorCall(contract,{x:2},'FLASH_LOAN'),'0x1234');
  assert.equal(calls.at(-1)[0],'initiateFlashLoan');
  assert.throws(()=>encodeExecutorCall(contract,{},'UNKNOWN'),/Unsupported funding mode/);
});
