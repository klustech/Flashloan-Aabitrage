const {Contract,Wallet,utils}=require('ethers');
const crypto=require('crypto');
const {productionProfile}=require('../config/productionProfile');
const {TokenRegistry}=require('../market/tokenRegistry');
const {PoolRegistry,edge}=require('../market/poolRegistry');
const {createProvider,pinnedBlock}=require('../market/marketState');
const {createAdapters}=require('../dex');
const {AaveV2}=require('../flashloan/aaveV2');
const {QuoteEngine}=require('./quoteEngine');
const {sizeTrade}=require('./tradeSizer');
const {profitability}=require('./profitabilityEngine');
const {discoverCandidates,priceMovementBps}=require('./opportunityEngine');
const {builderTip}=require('../execution/builderTip');
const {PrivateRelays}=require('../execution/privateRelays');
const {TradeLedger}=require('./tradeLedger');
const {PaperBurnIn}=require('./paperBurnIn');
const {ExecutionEngine}=require('./executionEngine');
const {startupChecks,commissioningChecks}=require('./readiness');
const {executionGuard}=require('../risk/executionGuard');
const {tradingState}=require('./stateMachine');
const {bn,address,serialize}=require('./units');
const eventBus=require('../utils/eventBus');
class Coordinator {
  constructor({provider,profile,state=tradingState,ledger,wallet,adapters}={}){
    this.profile=profile||productionProfile();this.provider=provider||createProvider();this.state=state;
    this.wallet=wallet|| (process.env.PRIVATE_KEY?new Wallet(process.env.PRIVATE_KEY,this.provider):null);
    this.contract=new Contract(this.profile.contractAddress,require('../abis/ArbitrageFlashloan.json'),this.provider);
    this.tokens=new TokenRegistry(this.provider,this.profile.chainId);this.poolRegistry=new PoolRegistry(this.tokens);
    this.adapters=adapters||createAdapters(this.provider,this.profile);this.quoter=new QuoteEngine(this.adapters);this.flashloan=new AaveV2(this.provider,this.profile.flashloanProvider);
    this.ledger=ledger||new TradeLedger({persist:async row=>{const db=require('../dbClient');if(db.isDbEnabled())await db.upsertExecution(row);else if(process.env.NODE_ENV==='production')throw new Error('Execution database unavailable');}});
    this.relays=new PrivateRelays(this.provider,this.profile.relays,process.env.FLASHBOTS_AUTH_KEY);
    this.burnIn=new PaperBurnIn(this.profile);
    this.busy=false;this.initialized=false;this.lastCycle=null;this.readiness=null;this.overrides={};
    this.execution=new ExecutionEngine({provider:this.provider,profile:this.profile,contract:this.contract,wallet:this.wallet,state:this.state,ledger:this.ledger,relays:this.relays,emit:this.emit.bind(this),converter:this.converter.bind(this),calculateEconomics:this.calculateEconomics.bind(this)});
  }
  emit(type,value){eventBus.emit(type,serialize(value));}
  async reject(candidate,reason){
    const row={id:crypto.randomUUID(),candidateId:candidate.id,mode:this.state.snapshot().mode,status:'DROPPED',reason,route:candidate,borrowToken:candidate.borrowToken,token:this.tokens.get(candidate.borrowToken),discoveredAt:Date.now()};
    await this.ledger.write(row);this.emit('opportunity_rejected',row);
  }
  async initialize(){if(this.initialized)return;const net=await this.provider.getNetwork();if(net.chainId!==this.profile.chainId)throw new Error('Ethereum mainnet RPC required');const block=await pinnedBlock(this.provider);await this.tokens.load(Object.fromEntries(this.profile.tokenSymbols.map(s=>[s,this.profile.tokens[s]])),block.number);this.operatorAddress=this.wallet?.address||this.profile.operatorAddress||await this.contract.owner();
    const db=require('../dbClient');if(db.isDbEnabled())for(const record of await db.getExecutions(10000)){const local=this.ledger.records.get(record.id);if(!local||local.updatedAt<record.updatedAt)this.ledger.records.set(record.id,record);}
    this.initialized=true;}
  async checkReadiness(){await this.initialize();const chain=await startupChecks({provider:this.provider,contract:this.contract,profile:this.profile,operatorAddress:this.operatorAddress});const evidence=commissioningChecks(this.profile);const errors=[...chain.errors,...evidence.errors];
    if(process.env.NODE_ENV==='production'){const db=require('../dbClient');try{await db.getExecutions(1);}catch(err){errors.push('Execution persistence: '+err.message);}}if(this.ledger.pending().length)errors.push('Unsettled private submissions');this.readiness={...chain,ready:errors.length===0,errors,evidence:evidence.evidence};return this.readiness;}
  async arm(){const revision=this.state.revision;const report=await this.checkReadiness();if(revision!==this.state.revision)throw new Error('Trading state changed during readiness check');return this.state.arm(report);}
  converter(token){
    const borrow=address(token),weth=address(this.profile.tokens.WETH);
    if(borrow===weth)return {toBorrow:async v=>bn(v),toNative:async v=>bn(v)};
    const pool=this.poolRegistry.values().find(p=>p.dex==='uniswap_v2'&&[p.token0,p.token1].includes(borrow)&&[p.token0,p.token1].includes(weth));
    if(!pool)throw new Error('Missing exact Uniswap V2 gas valuation pool');const leg=edge(pool,borrow),adapter=this.adapters.uniswap_v2;
    return {toBorrow:async(v,block)=>bn(v).isZero()?bn(0):adapter.quoteExactOutput(leg,v,block),toNative:async(v,block)=>bn(v).lte(0)?bn(0):adapter.quoteExactInput(leg,v,block)};
  }
  async discover(){
    await this.initialize();const block=await pinnedBlock(this.provider);this.poolRegistry=new PoolRegistry(this.tokens);
    const tokenAddresses=this.profile.tokenSymbols.map(s=>address(this.profile.tokens[s]));
    const results=await Promise.allSettled(Object.values(this.adapters).map(a=>a.discoverPools(tokenAddresses,block.number)));
    for(let i=0;i<results.length;i++){const r=results[i];if(r.status==='fulfilled')for(const pool of r.value)this.poolRegistry.add(pool);else this.emit('discovery_rejected',{dex:Object.keys(this.adapters)[i],reason:r.reason.message});}
    return {block,candidates:discoverCandidates(this.poolRegistry,this.profile.borrowSymbols.map(s=>address(this.profile.tokens[s])),block.number)};
  }
  async refresh(route,block){
    const registry=new PoolRegistry(this.tokens),legs=[];
    for(const leg of route.legs){const state=await this.adapters[leg.dex].getPoolState(leg,block.number);const fresh=edge(registry.add({...leg,...state}),leg.tokenIn);if(priceMovementBps(leg,fresh).gt(this.profile.maxPriceMovementBps))throw new Error('Pool price moved beyond limit');legs.push(fresh);}
    return {...route,legs,hops:legs,stateBlock:block.number};
  }
  async calculateEconomics(quote,gasUnits,tip,terms,blockTag){
    const convert=this.converter(quote.route.borrowToken);
    const gasNative=bn(gasUnits).mul(tip.baseFeePerGas),builderNative=bn(gasUnits).mul(tip.maxPriorityFeePerGas);
    // Convert the aggregate cost, then allocate it. Separate AMM conversions
    // can understate total cost through price impact/rounding.
    const totalBorrow=await convert.toBorrow(gasNative.add(builderNative),blockTag),gasBorrow=await convert.toBorrow(gasNative,blockTag);
    return profitability({borrowToken:quote.route.borrowToken,borrowAmount:quote.borrowAmount,expectedFinalAmount:quote.expectedFinalAmount,flashloanFee:this.flashloan.fee(quote.borrowAmount,terms.premiumBps),estimatedGasUnits:gasUnits,gasCostNative:gasNative,gasCostBorrowToken:gasBorrow,builderPaymentNative:builderNative,builderPaymentBorrowToken:totalBorrow.sub(gasBorrow),minimumRequiredProfit:this.tokens.parse(quote.route.borrowToken,this.profile.minimumRequiredProfit)});
  }
  async evaluate(route,amount,terms,block){
    const quote=await this.quoter.quoteRoute(route,amount,block.number);
    const gross=quote.expectedFinalAmount.sub(amount).sub(this.flashloan.fee(amount,terms.premiumBps));
    const nativeGross=await this.converter(route.borrowToken).toNative(gross,block.number);
    if (gross.lte(this.tokens.parse(route.borrowToken,this.profile.minimumRequiredProfit))) throw new Error('Not profitable after premium');
    const data=this.quoter.buildData(quote,this.tokens.parse(route.borrowToken,this.profile.minimumRequiredProfit),Math.min(this.overrides.slippageBps??this.profile.slippageBps,this.profile.slippageBps));
    const transaction={to:this.contract.address,from:address(this.operatorAddress),data:this.contract.interface.encodeFunctionData('initiateFlashLoan',[data])};
    await this.provider.call(transaction,block.number);
    const seedGas=bn(await this.provider.estimateGas(transaction)).mul(120).add(99).div(100);
    if(seedGas.gt(this.profile.maxGasUnits))throw new Error('Sizing gas exceeds ceiling');
    const tip=builderTip({profitNativeWei:nativeGross,baseFeePerGas:block.baseFeePerGas,gasLimit:seedGas,maxBuilderShareBps:this.profile.maxBuilderShareBps,maxPriorityFeePerGas:utils.parseUnits('5','gwei')});
    const economics=await this.calculateEconomics(quote,seedGas,tip,terms,block.number);
    return {quote,economics,tip};
  }
  async prepare(best,terms,block,signal){
    const route=await this.refresh(best.quote.route,block);
    const quote=await this.quoter.quoteRoute(route,best.quote.borrowAmount,block.number);
    const gross=quote.expectedFinalAmount.sub(quote.borrowAmount).sub(this.flashloan.fee(quote.borrowAmount,terms.premiumBps));
    const nativeGross=await this.converter(route.borrowToken).toNative(gross,block.number);
    const preliminary=this.quoter.buildData(quote,this.tokens.parse(route.borrowToken,this.profile.minimumRequiredProfit),Math.min(this.overrides.slippageBps??this.profile.slippageBps,this.profile.slippageBps));
    const from=address(this.operatorAddress);
    await this.provider.call({to:this.contract.address,from,data:this.contract.interface.encodeFunctionData('initiateFlashLoan',[preliminary])},block.number);
    const gasEstimate=await this.provider.estimateGas({to:this.contract.address,from,data:this.contract.interface.encodeFunctionData('initiateFlashLoan',[preliminary])});
    const gasLimit=bn(gasEstimate).mul(120).add(99).div(100);
    if(gasLimit.gt(this.profile.maxGasUnits))throw new Error('Estimated gas exceeds limit');
    const tip=builderTip({profitNativeWei:nativeGross,baseFeePerGas:block.baseFeePerGas,gasLimit,maxBuilderShareBps:this.profile.maxBuilderShareBps,maxPriorityFeePerGas:utils.parseUnits('5','gwei')});
    const hardCeiling=utils.parseUnits(String(this.profile.gasCeilingGwei),'gwei'),requestedCeiling=utils.parseUnits(String(this.overrides.gasCeilingGwei??this.profile.gasCeilingGwei),'gwei');const ceiling=requestedCeiling.lt(hardCeiling)?requestedCeiling:hardCeiling;if(tip.maxFeePerGas.gt(ceiling))throw new Error('Gas price exceeds ceiling');
    const economics=await this.calculateEconomics(quote,gasLimit,tip,terms,block.number);
    const minProfit=economics.minimumRequiredProfit.add(economics.estimatedGasCostBorrowToken).add(economics.estimatedBuilderPaymentBorrowToken);
    const data=this.quoter.buildData(quote,minProfit,Math.min(this.overrides.slippageBps??this.profile.slippageBps,this.profile.slippageBps));
    const transaction={to:this.contract.address,from,data:this.contract.interface.encodeFunctionData('initiateFlashLoan',[data]),gasLimit,maxFeePerGas:tip.maxFeePerGas,maxPriorityFeePerGas:tip.maxPriorityFeePerGas};
    await this.provider.call(transaction,block.number);
    const head=await pinnedBlock(this.provider);if(head.hash!==block.hash)throw new Error('Quote expired across chain head');
    executionGuard({route,quote,economics,profile:this.profile,head:head.number,signal});
    const record={id:crypto.randomUUID(),candidateId:route.id,status:'DISCOVERED',mode:this.state.snapshot().mode,discoveredAt:Date.now(),profileFingerprint:this.profile.fingerprint,borrowToken:route.borrowToken,token:this.tokens.get(route.borrowToken),borrowAmount:quote.borrowAmount,flashloanPremium:economics.flashloanFee,route,swapData:data,economics,stateBlock:block.number,stateBlockHash:block.hash,profitRecipient:await this.contract.profitRecipient(),weth:this.profile.tokens.WETH};
    await this.ledger.write(record);
    return {quote,economics,tip,terms,block,transaction,record};
  }
  async cycle({signal}={}){
    if(this.busy)return {executed:false,reason:'cycle_already_running'};
    if(!['PAPER','LIVE_RUNNING'].includes(this.state.state))return {executed:false,reason:'scanner_stopped_or_paused'};
    this.busy=true;const revision=this.state.revision;let prepared=null;
    try{
      if(signal?.aborted)throw new Error('Aborted');
      const found=await this.discover();
      if(await this.execution.reconcile())return {executed:false,reason:'pending_receipt'};
      const finalists=[];
      for(const candidate of found.candidates.slice(0,this.profile.maxCandidates)){
        try{
          if(signal?.aborted||revision!==this.state.revision)throw new Error('Scan interrupted');
          const block=await pinnedBlock(this.provider),route=await this.refresh(candidate,block),terms=await this.flashloan.terms(route.borrowToken,block.number);
          const configuredMaximum=this.tokens.parse(route.borrowToken,this.profile.maxBorrowAmount);
          const requestedMaximum=this.tokens.parse(route.borrowToken,this.overrides.maxBorrowAmount??this.profile.maxBorrowAmount);
          const maximum=requestedMaximum.lt(configuredMaximum)?requestedMaximum:configuredMaximum;
          const maxInput=maximum.lt(terms.availableLiquidity)?maximum:terms.availableLiquidity;
          const minimum=this.tokens.parse(route.borrowToken,this.overrides.minBorrowAmount??this.profile.minBorrowAmount);
          const sized=await sizeTrade({route,minInput:minimum,maxInput,premiumBps:terms.premiumBps,evaluate:amount=>this.evaluate(route,amount,terms,block)});
          if(sized?.economics.profitable)finalists.push({...sized,terms});else await this.reject(candidate,'no_profitable_exact_size');
        }catch(err){await this.reject(candidate,err.message);}
      }
      // Candidates for different borrow tokens are compared in executable native units.
      for(const f of finalists)f.netNative=await this.converter(f.quote.route.borrowToken).toNative(f.economics.expectedNetProfit,f.quote.stateBlock);
      finalists.sort((a,b)=>a.netNative.gt(b.netNative)?-1:1);
      for(const best of finalists){try{const block=await pinnedBlock(this.provider),terms=await this.flashloan.terms(best.quote.route.borrowToken,block.number);prepared=await this.prepare(best,terms,block,signal);break;}catch(err){await this.reject(best.quote.route,err.message);}}
      if(!prepared){this.lastCycle={at:Date.now(),mode:this.state.snapshot().mode,candidates:found.candidates.length,reason:'no_profitable_simulated_candidate'};return {executed:false,...this.lastCycle};}
      if(revision!==this.state.revision)throw new Error('Trading mode changed during cycle');
      if(this.state.state==='PAPER'){
        const record=await this.ledger.write({...prepared.record,status:'SIMULATED',simulation:{callStatic:true,bundle:false,bundleReason:'PAPER does not sign transactions'}});
        this.emit('opportunity',record);this.lastCycle={at:Date.now(),mode:'PAPER',simulated:true,candidates:found.candidates.length};return {executed:false,simulated:true,mode:'PAPER',estimatedProfitInDai:prepared.economics.expectedNetProfit,trade:serialize(record)};
      }
      const readiness=await this.checkReadiness();if(!readiness.ready)throw new Error(readiness.errors.join('; '));
      const result=await this.execution.execute(prepared,{signal,revision});this.lastCycle={at:Date.now(),mode:'LIVE',status:result.status||result.trade?.status};return result;
    }catch(err){
      if(prepared){const saved=this.ledger.records.get(prepared.record.id);if(saved&&['DISCOVERED','SIMULATED'].includes(saved.status))await this.ledger.write({...saved,status:'DROPPED',reason:err.message});}
      this.lastCycle={at:Date.now(),mode:this.state.snapshot().mode,reason:err.message};this.emit('cycle_rejected',this.lastCycle);
      if(this.state.state==='LIVE_RUNNING')this.state.pause(err.message);
      return {executed:false,reason:err.message};
    }finally{if(this.state.state==='PAPER' && revision===this.state.revision)this.burnIn.record(this.lastCycle);this.busy=false;}
  }
  status(){return {trading:this.state.snapshot(),busy:this.busy,lastCycle:this.lastCycle,readiness:this.readiness,profile:{chain:this.profile.chain,chainId:this.profile.chainId,flashloanProvider:this.profile.flashloanProvider,strategies:['CROSS_DEX_TWO_LEG','TRIANGULAR_THREE_LEG'],fingerprint:this.profile.fingerprint},paperBurnIn:this.burnIn.data,summary:this.ledger.summary(),executions:this.ledger.recent(100)};}
}
let instance;
function getCoordinator(){if(!instance)instance=new Coordinator();return instance;}
module.exports={Coordinator,getCoordinator};
