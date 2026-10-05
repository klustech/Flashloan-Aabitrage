#!/usr/bin/env node
const fs=require('fs');
const path=require('path');
const {providers,BigNumber}=require('ethers');
const {productionProfile}=require('../server/config/productionProfile');
const {TokenRegistry}=require('../server/market/tokenRegistry');
const {PoolRegistry,edge}=require('../server/market/poolRegistry');
const {createAdapters}=require('../server/dex');
const {QuoteEngine}=require('../server/bot/quoteEngine');
const {AaveV2}=require('../server/flashloan/aaveV2');

async function main(){
  if(!process.env.MAINNET_RPC_URL)throw new Error('MAINNET_RPC_URL required');
  if(process.env.PRIVATE_KEY?.trim())throw new Error('Regression proof refuses PRIVATE_KEY');
  const fixturePath=process.argv[2]||path.join(__dirname,'../test/fixtures/backrun-26115902.json');
  const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  const topologyPath=process.env.POOL_CACHE_PATH||path.join(process.env.HOME||'.','rolling-mainnet-observer/results/pool-topology.json');
  if(!fs.existsSync(topologyPath))throw new Error(`Pool topology missing: ${topologyPath}`);

  const profile=productionProfile(process.env);
  const provider=new providers.JsonRpcProvider(process.env.MAINNET_RPC_URL,{name:'ethereum',chainId:1});
  const net=await provider.getNetwork();
  if(net.chainId!==1)throw new Error('Ethereum mainnet RPC required');

  const tokens=new TokenRegistry(provider,1);
  await tokens.load(Object.fromEntries(profile.tokenSymbols.map(s=>[s,profile.tokens[s]])),fixture.preBlock);
  const adapters=createAdapters(provider,profile);
  const topology=JSON.parse(fs.readFileSync(topologyPath,'utf8'));
  const registry=new PoolRegistry(tokens);
  let token=profile.tokens[fixture.borrowSymbol].toLowerCase();
  const legs=[];

  for(const ref of fixture.routePools){
    const pool=topology.pools.find(p=>p.poolAddress.toLowerCase()===ref.address.toLowerCase()&&p.dex===ref.dex);
    if(!pool)throw new Error(`Fixture pool missing from topology: ${ref.dex} ${ref.address}`);
    const state=await adapters[pool.dex].getPoolState(pool,fixture.preBlock);
    const leg=edge(registry.add({...pool,...state}),token);
    legs.push(leg);token=leg.tokenOut;
  }
  if(token!==profile.tokens[fixture.borrowSymbol].toLowerCase())throw new Error('Fixture route is not a cycle');

  const amount=BigNumber.from(fixture.amountIn);
  const route={id:fixture.name,strategy:'CROSS_DEX_TWO_LEG',chain:'ethereum',chainId:1,borrowToken:profile.tokens[fixture.borrowSymbol].toLowerCase(),legs,hops:legs,stateBlock:fixture.preBlock};
  const quoter=new QuoteEngine(adapters);quoter.beginBlock(`historical-${fixture.preBlock}`);
  const quote=await quoter.quoteRoute(route,amount,fixture.preBlock);
  const preGross=quote.expectedFinalAmount.sub(amount);
  const actualFinal=BigNumber.from(fixture.actualFinalAmount);
  const actualGross=actualFinal.sub(amount);

  const flashloan=new AaveV2(provider,profile.flashloanProvider);
  const terms=await flashloan.terms(route.borrowToken,fixture.preBlock);
  const fee=flashloan.fee(amount,terms.premiumBps);
  const observedGas=BigNumber.from(fixture.observedGasCostWei);
  const flashAfterGas=actualGross.sub(fee).sub(observedGas);

  const [trigger,arb]=await Promise.all([
    provider.getTransaction(fixture.triggerTransaction),
    provider.getTransaction(fixture.arbitrageTransaction)
  ]);
  const result={
    fixture:fixture.name,
    preBlock:fixture.preBlock,
    preBlockExpectedFinalAmount:quote.expectedFinalAmount.toString(),
    preBlockGross:preGross.toString(),
    actualGross:actualGross.toString(),
    aavePremiumBps:terms.premiumBps,
    aaveFee:fee.toString(),
    observedGasCostWei:observedGas.toString(),
    flashloanAfterObservedGas:flashAfterGas.toString(),
    triggerTransactionIndex:trigger.transactionIndex,
    arbitrageTransactionIndex:arb.transactionIndex,
    passed:
      quote.expectedFinalAmount.lte(amount)&&
      actualFinal.gt(amount)&&
      trigger.transactionIndex+1===arb.transactionIndex&&
      flashAfterGas.lt(0)
  };
  console.log(JSON.stringify(result,null,2));
  if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(err=>{console.error(err.message);process.exitCode=1;});
module.exports={main};
