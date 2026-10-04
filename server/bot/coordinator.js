const {Contract,Wallet,utils}=require('ethers');
const {assertLiveAllowed}=require('../config/paperPolicy');
const crypto=require('crypto');
const {productionProfile}=require('../config/productionProfile');
const {TokenRegistry}=require('../market/tokenRegistry');
const {PoolRegistry,edge}=require('../market/poolRegistry');
const {createProvider,pinnedBlock}=require('../market/marketState');
const {createAdapters}=require('../dex');
const {AaveV2}=require('../flashloan/aaveV2');
const {QuoteEngine}=require('./quoteEngine');
const {sizeTrade,sizingSeed}=require('./tradeSizer');
const {PoolStateCache}=require('../market/poolStateCache');
const {abortError,checkSignal,abortable,mapLimit}=require('./asyncControl');
const {profitability}=require('./profitabilityEngine');
const {priceMovementBps,CandidateIndex}=require('./opportunityEngine');
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
    if(this.profile.paperOnly&&wallet)throw new Error('PAPER_ONLY refuses a supplied signer');
    this.wallet=wallet|| (process.env.PRIVATE_KEY?new Wallet(process.env.PRIVATE_KEY,this.provider):null);
    this.contract=new Contract(this.profile.contractAddress,require('../abis/ArbitrageFlashloan.json'),this.provider);
    this.tokens=new TokenRegistry(this.provider,this.profile.chainId);this.poolRegistry=new PoolRegistry(this.tokens);
    this.adapters=adapters||createAdapters(this.provider,this.profile);this.quoter=new QuoteEngine(this.adapters);this.flashloan=new AaveV2(this.provider,this.profile.flashloanProvider);
    this.marketCache=new PoolStateCache({provider:this.provider,adapters:this.adapters,tokens:this.tokens,profile:this.profile});
    this.termsCache=new Map();this.candidateIndex=new CandidateIndex();this.latency=null;
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
  async arm(){assertLiveAllowed(this.profile);const revision=this.state.revision;const report=await this.checkReadiness();if(revision!==this.state.revision)throw new Error('Trading state changed during readiness check');return this.state.arm(report);}
  converter(token){
    const borrow=address(token),weth=address(this.profile.tokens.WETH);
    if(borrow===weth)return {toBorrow:async v=>bn(v),toNative:async v=>bn(v)};
    const pool=this.poolRegistry.values().find(p=>p.dex==='uniswap_v2'&&[p.token0,p.token1].includes(borrow)&&[p.token0,p.token1].includes(weth));
    if(!pool)throw new Error('Missing exact Uniswap V2 gas valuation pool');const leg=edge(pool,borrow);
    return {toBorrow:async(v,block)=>bn(v).isZero()?bn(0):this.quoter.quoteLeg(leg,v,block,'output'),toNative:async(v,block)=>bn(v).lte(0)?bn(0):this.quoter.quoteLeg(leg,v,block,'input')};
  }
  async discover(signal){
    await abortable(this.initialize(),signal);const block=await abortable(pinnedBlock(this.provider),signal);
    const snapshot=await this.marketCache.sync(block,{signal});this.poolRegistry=snapshot.registry;
    return {block,candidates:this.candidateIndex.screeningCandidates(this.poolRegistry,this.profile.borrowSymbols.map(s=>address(this.profile.tokens[s])),block.number,snapshot.changedPools)};
  }
  async refresh(route,block,signal){
    const registry=new PoolRegistry(this.tokens);
    const legs=await mapLimit(route.legs,3,async leg=>{
      const cached=this.marketCache?.head?.hash===block.hash?this.poolRegistry.values().find(p=>p.poolAddress===leg.poolAddress&&p.dex===leg.dex):null;
      const state=cached||await this.adapters[leg.dex].getPoolState(leg,block.number);
      const fresh=edge(registry.add({...leg,...state}),leg.tokenIn);if(priceMovementBps(leg,fresh).gt(this.profile.maxPriceMovementBps))throw new Error('Pool price moved beyond limit');return fresh;
    },signal);
    return {...route,legs,hops:legs,stateBlock:block.number};
  }
  terms(token,block,signal){
    this.termsCache ||= new Map();
    const key=`${block.hash}:${token}`;if(!this.termsCache.has(key))this.termsCache.set(key,this.flashloan.terms(token,block.number));
    return abortable(this.termsCache.get(key),signal);
  }
  bounds(route,terms){
    const cap=this.tokens.parse(route.borrowToken,this.profile.maxBorrowAmount),requested=this.tokens.parse(route.borrowToken,this.overrides.maxBorrowAmount??this.profile.maxBorrowAmount);
    const maximum=requested.lt(cap)?requested:cap;
    return {minInput:this.tokens.parse(route.borrowToken,this.overrides.minBorrowAmount??this.profile.minBorrowAmount),maxInput:maximum.lt(terms.availableLiquidity)?maximum:terms.availableLiquidity};
  }
  async calculateEconomics(quote,gasUnits,tip,terms,blockTag){
    const convert=this.converter(quote.route.borrowToken);
    const gasNative=bn(gasUnits).mul(tip.baseFeePerGas),builderNative=bn(gasUnits).mul(tip.maxPriorityFeePerGas);
    // Convert the aggregate cost, then allocate it. Separate AMM conversions
    // can understate total cost through price impact/rounding.
    const totalBorrow=await convert.toBorrow(gasNative.add(builderNative),blockTag),gasBorrow=await convert.toBorrow(gasNative,blockTag);
    return profitability({borrowToken:quote.route.borrowToken,borrowAmount:quote.borrowAmount,expectedFinalAmount:quote.expectedFinalAmount,flashloanFee:this.flashloan.fee(quote.borrowAmount,terms.premiumBps),estimatedGasUnits:gasUnits,gasCostNative:gasNative,gasCostBorrowToken:gasBorrow,builderPaymentNative:builderNative,builderPaymentBorrowToken:totalBorrow.sub(gasBorrow),minimumRequiredProfit:this.tokens.parse(quote.route.borrowToken,this.profile.minimumRequiredProfit)});
  }
  async evaluate(route,amount,terms,block,signal){
    const quote=await this.quoter.quoteRoute(route,amount,block.number,signal);
    const gross=quote.expectedFinalAmount.sub(amount).sub(this.flashloan.fee(amount,terms.premiumBps));
    const nativeGross=await abortable(this.converter(route.borrowToken).toNative(gross,block.number),signal);
    if (gross.lte(this.tokens.parse(route.borrowToken,this.profile.minimumRequiredProfit))) throw new Error('Not profitable after premium');
    // Screening/sizing gas is provisional. The selected route must still pass
    // full executor calls, a measured gas estimate and net checks in prepare.
    const seedGas=bn(120000+130000*route.legs.length);
    if(seedGas.gt(this.profile.maxGasUnits))throw new Error('Sizing gas exceeds ceiling');
    const tip=builderTip({profitNativeWei:nativeGross,baseFeePerGas:block.baseFeePerGas,gasLimit:seedGas,maxBuilderShareBps:this.profile.maxBuilderShareBps,maxPriorityFeePerGas:utils.parseUnits('5','gwei')});
    const economics=await abortable(this.calculateEconomics(quote,seedGas,tip,terms,block.number),signal);
    economics.gasEstimation='screening_heuristic';checkSignal(signal);
    return {quote,economics,tip};
  }
  async prepare(best,terms,block,signal){
    checkSignal(signal);const route=await this.refresh(best.quote.route,block,signal);
    const quote=await this.quoter.quoteRoute(route,best.quote.borrowAmount,block.number,signal);
    const gross=quote.expectedFinalAmount.sub(quote.borrowAmount).sub(this.flashloan.fee(quote.borrowAmount,terms.premiumBps));
    const nativeGross=await abortable(this.converter(route.borrowToken).toNative(gross,block.number),signal);
    const preliminary=this.quoter.buildData(quote,this.tokens.parse(route.borrowToken,this.profile.minimumRequiredProfit),Math.min(this.overrides.slippageBps??this.profile.slippageBps,this.profile.slippageBps));
    const from=address(this.operatorAddress);
    this.scanStats.transactionCalls++;await abortable(this.provider.call({to:this.contract.address,from,data:this.contract.interface.encodeFunctionData('initiateFlashLoan',[preliminary])},block.number),signal);
    this.scanStats.gasEstimates++;const gasEstimate=await abortable(this.provider.estimateGas({to:this.contract.address,from,data:this.contract.interface.encodeFunctionData('initiateFlashLoan',[preliminary])}),signal);
    const gasLimit=bn(gasEstimate).mul(120).add(99).div(100);
    if(gasLimit.gt(this.profile.maxGasUnits))throw new Error('Estimated gas exceeds limit');
    const tip=builderTip({profitNativeWei:nativeGross,baseFeePerGas:block.baseFeePerGas,gasLimit,maxBuilderShareBps:this.profile.maxBuilderShareBps,maxPriorityFeePerGas:utils.parseUnits('5','gwei')});
    const hardCeiling=utils.parseUnits(String(this.profile.gasCeilingGwei),'gwei'),requestedCeiling=utils.parseUnits(String(this.overrides.gasCeilingGwei??this.profile.gasCeilingGwei),'gwei');const ceiling=requestedCeiling.lt(hardCeiling)?requestedCeiling:hardCeiling;if(tip.maxFeePerGas.gt(ceiling))throw new Error('Gas price exceeds ceiling');
    const economics=await abortable(this.calculateEconomics(quote,gasLimit,tip,terms,block.number),signal);economics.gasEstimation='executor_estimate_with_margin';
    const minProfit=economics.minimumRequiredProfit.add(economics.estimatedGasCostBorrowToken).add(economics.estimatedBuilderPaymentBorrowToken);
    const data=this.quoter.buildData(quote,minProfit,Math.min(this.overrides.slippageBps??this.profile.slippageBps,this.profile.slippageBps));
    const transaction={to:this.contract.address,from,data:this.contract.interface.encodeFunctionData('initiateFlashLoan',[data]),gasLimit,maxFeePerGas:tip.maxFeePerGas,maxPriorityFeePerGas:tip.maxPriorityFeePerGas};
    this.scanStats.transactionCalls++;await abortable(this.provider.call(transaction,block.number),signal);
    const head=await abortable(pinnedBlock(this.provider),signal);if(head.hash!==block.hash)throw abortError('Quote expired across chain head');
    executionGuard({route,quote,economics,profile:this.profile,head:head.number,signal});
    const profitRecipient=await abortable(this.contract.profitRecipient({blockTag:block.number}),signal);checkSignal(signal);
    const record={id:crypto.randomUUID(),candidateId:route.id,status:'DISCOVERED',mode:this.state.snapshot().mode,discoveredAt:Date.now(),profileFingerprint:this.profile.fingerprint,borrowToken:route.borrowToken,token:this.tokens.get(route.borrowToken),borrowAmount:quote.borrowAmount,flashloanPremium:economics.flashloanFee,route,swapData:data,economics,stateBlock:block.number,stateBlockHash:block.hash,profitRecipient,weth:this.profile.tokens.WETH};
    await this.ledger.write(record);
    return {quote,economics,tip,terms,block,transaction,record};
  }
  async screenCandidates(candidates,block,revision,signal,cycleDeadline){
    const controller=new AbortController(),cancel=()=>controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    const budget=this.profile.scanBudgetMs||5000;
    // Reserve half the warm budget for sizing and mandatory executor checks.
    const allowance=Math.max(1,Math.min(budget/2,cycleDeadline-Date.now()-budget/2));
    const timer=setTimeout(cancel,allowance),screenSignal=controller.signal,screened=[];
    const cap=Math.min(candidates.length,this.profile.maxScreenedCandidates||48),batchSize=this.profile.maxCandidates||4;
    this.scanStats.screeningAttempted=0;this.scanStats.screeningPassed=0;this.scanStats.screeningBatches=0;
    this.scanStats.screeningStopReason=cap<candidates.length?'candidate_cap':'exhausted';
    try{
      for(let offset=0;offset<cap;offset+=batchSize){
        checkSignal(signal);checkSignal(screenSignal);this.scanStats.screeningBatches++;
        await mapLimit(candidates.slice(offset,Math.min(offset+batchSize,cap)),2,async candidate=>{
          try{
            checkSignal(screenSignal);if(revision!==this.state.revision)throw abortError('Scan interrupted');
            this.scanStats.screeningAttempted++;this.candidateIndex?.markScreened(candidate.id);
            const route=await this.refresh(candidate,block,screenSignal),terms=await this.terms(route.borrowToken,block,screenSignal);
            // Marginal rates only prefilter; exact quotes decide executability.
            if(route.spreadPpm&&route.spreadPpm.lte(terms.premiumBps*100)){await this.reject(candidate,'marginal_spread_below_premium');return;}
            const bounds=this.bounds(route,terms);if(bounds.maxInput.lt(bounds.minInput))throw new Error('Insufficient liquidity for minimum size');
            let seed=bounds.minInput;try{seed=bn(sizingSeed(route,bounds.maxInput,terms.premiumBps));}catch(_){}
            if(seed.lt(bounds.minInput))seed=bounds.minInput;if(seed.gt(bounds.maxInput))seed=bounds.maxInput;
            this.scanStats.screened++;
            const result=await this.evaluate(route,seed,terms,block,screenSignal);
            if(!result.economics.profitable){checkSignal(screenSignal);await this.reject(candidate,'exact_screen_not_profitable');return;}
            const netNative=await abortable(this.converter(route.borrowToken).toNative(result.economics.expectedNetProfit,block.number),screenSignal);
            checkSignal(screenSignal);screened.push({route,terms,bounds,result,netNative});this.scanStats.screeningPassed++;
          }catch(err){if(err.name==='AbortError')throw err;checkSignal(screenSignal);await this.reject(candidate,err.message);}
        },screenSignal);
        if(screened.length>=(this.profile.maxSizedCandidates||1)){this.scanStats.screeningStopReason='enough_profitable';break;}
      }
    }catch(err){
      // A screening deadline may retain completed exact quotes for preparation.
      // A new block, pause or outer timeout must still cancel the entire scan.
      checkSignal(signal);if(revision!==this.state.revision)throw abortError('Scan interrupted');
      if(err.name!=='AbortError')throw err;this.scanStats.screeningStopReason='screening_budget';
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
    return screened.sort((a,b)=>a.netNative.gt(b.netNative)?-1:a.netNative.lt(b.netNative)?1:0);
  }
  async cycle({signal}={}){
    if(this.busy)return {executed:false,reason:'cycle_already_running'};
    const scanning=['PAPER','LIVE_RUNNING'].includes(this.state.state);
    if(!scanning&&!this.ledger.pending().length)return {executed:false,reason:'scanner_stopped_or_paused'};
    this.busy=true;const revision=this.state.revision;let prepared=null;
    const startedAt=Date.now(),controller=new AbortController(),externalSignal=signal;
    const cancel=()=>controller.abort();externalSignal?.addEventListener('abort',cancel,{once:true});if(externalSignal?.aborted)cancel();signal=controller.signal;
    const cycleBudget=this.marketCache&&!this.marketCache.head?60000:(this.profile.scanBudgetMs||5000),cycleDeadline=startedAt+cycleBudget;
    const timer=setTimeout(cancel,cycleBudget);
    this.scanStats={screened:0,sized:0,transactionCalls:0,gasEstimates:0,stageTimes:{}};
    try{
      checkSignal(signal);
      const found=await this.discover(signal),block=found.block||await abortable(pinnedBlock(this.provider),signal);
      this.scanStats.stageTimes.cacheMs=Date.now()-startedAt;
      this.quoter?.beginBlock(block.hash);this.termsCache?.clear();
      if(await this.execution.reconcile())return {executed:false,reason:'pending_receipt'};
      if(!scanning)return {executed:false,reason:'receipts_reconciled_while_paused'};
      const screeningStarted=Date.now();
      const ranked=await this.screenCandidates(found.candidates,block,revision,signal,cycleDeadline);
      this.scanStats.stageTimes.screeningMs=Date.now()-screeningStarted;
      const sizingStarted=Date.now();
      const finalists=[];
      for(const item of ranked.slice(0,this.profile.maxSizedCandidates||1)){
        checkSignal(signal);this.scanStats.sized++;
        const sized=await sizeTrade({route:item.route,...item.bounds,premiumBps:item.terms.premiumBps,samples:this.profile.sizingSamples||4,refinements:this.profile.sizingRefinements??1,signal,evaluate:amount=>this.evaluate(item.route,amount,item.terms,block,signal)});
        if(sized?.economics.profitable){const netNative=await abortable(this.converter(item.route.borrowToken).toNative(sized.economics.expectedNetProfit,block.number),signal);finalists.push({...sized,terms:item.terms,netNative});}
        else await this.reject(item.route,'no_profitable_exact_size');
      }
      this.scanStats.stageTimes.sizingMs=Date.now()-sizingStarted;
      finalists.sort((a,b)=>a.netNative.gt(b.netNative)?-1:1);
      const preparationStarted=Date.now();
      for(const best of finalists){try{checkSignal(signal);const head=await abortable(pinnedBlock(this.provider),signal);if(head.hash!==block.hash)throw abortError('Chain head advanced during sizing');prepared=await this.prepare(best,best.terms,block,signal);break;}catch(err){if(err.name==='AbortError')throw err;await this.reject(best.quote.route,err.message);}}
      this.scanStats.stageTimes.preparationMs=Date.now()-preparationStarted;
      if(!prepared){this.lastCycle={at:Date.now(),mode:this.state.snapshot().mode,candidates:found.candidates.length,reason:'no_profitable_simulated_candidate'};return {executed:false,...this.lastCycle};}
      checkSignal(signal);if(revision!==this.state.revision)throw abortError('Trading mode changed during cycle');
      if(this.state.state==='PAPER'){
        const record=await this.ledger.write({...prepared.record,status:'SIMULATED',simulation:{callStatic:true,bundle:false,bundleReason:'PAPER does not sign transactions'}});
        this.emit('opportunity',record);this.lastCycle={at:Date.now(),mode:'PAPER',simulated:true,candidates:found.candidates.length};return {executed:false,simulated:true,mode:'PAPER',estimatedProfitInDai:prepared.economics.expectedNetProfit,trade:serialize(record)};
      }
      const readinessStarted=Date.now(),readiness=await abortable(this.checkReadiness(),signal);this.scanStats.stageTimes.readinessMs=Date.now()-readinessStarted;if(!readiness.ready)throw new Error(readiness.errors.join('; '));
      const executionStarted=Date.now(),result=await this.execution.execute(prepared,{signal,revision});this.scanStats.stageTimes.executionMs=Date.now()-executionStarted;this.lastCycle={at:Date.now(),mode:'LIVE',status:result.status||result.trade?.status};return result;
    }catch(err){
      if(prepared){const saved=this.ledger.records.get(prepared.record.id);if(saved&&['DISCOVERED','SIMULATED'].includes(saved.status))await this.ledger.write({...saved,status:'DROPPED',reason:err.message});}
      this.lastCycle={at:Date.now(),mode:this.state.snapshot().mode,reason:err.message};this.emit('cycle_rejected',this.lastCycle);
      if(this.state.state==='LIVE_RUNNING'&&err.name!=='AbortError')this.state.pause(err.message);
      return {executed:false,reason:err.message};
    }finally{clearTimeout(timer);externalSignal?.removeEventListener('abort',cancel);this.latency={durationMs:Date.now()-startedAt,...this.scanStats,quotes:this.quoter?.stats,cache:this.marketCache?.status(),candidates:this.candidateIndex?.stats};if(this.lastCycle)this.lastCycle.latency=this.latency;this.emit('scan_completed',this.latency);if(this.state.state==='PAPER' && revision===this.state.revision)this.burnIn.record(this.lastCycle);this.busy=false;}
  }
  status(){return {trading:this.state.snapshot(),busy:this.busy,lastCycle:this.lastCycle,latency:this.latency,scanner:this.scheduler?.status(),backrun:this.backrunService?.status?.(),readiness:this.readiness,safety:{paperOnly:this.profile.paperOnly,hasPrivateKey:Boolean(process.env.PRIVATE_KEY?.trim()),activity:{...this.execution.activity,backrunSignatures:this.backrunService?.engine?.activity?.signatures||0,backrunSubmissions:this.backrunService?.engine?.activity?.submissions||0}},profile:{paperOnly:this.profile.paperOnly,chain:this.profile.chain,chainId:this.profile.chainId,opportunityMode:this.profile.opportunityMode,flashloanProvider:this.profile.flashloanProvider,strategies:['CROSS_DEX_TWO_LEG','TRIANGULAR_THREE_LEG',...(this.profile.backrun?.enabled?['TRANSACTION_TRIGGERED_BACKRUN']:[])],fingerprint:this.profile.fingerprint},paperBurnIn:this.burnIn.data,summary:this.ledger.summary(),executions:this.ledger.recent(100)};}
}
let instance;
function getCoordinator(){if(!instance)instance=new Coordinator();return instance;}
module.exports={Coordinator,getCoordinator};