const crypto = require("crypto");
const { Contract, utils } = require("ethers");
const { assertLiveAllowed } = require("../config/paperPolicy");
const { createAdapters } = require("../dex");
const { AaveV2 } = require("../flashloan/aaveV2");
const { PoolRegistry, edge } = require("../market/poolRegistry");
const { pinnedBlock } = require("../market/marketState");
const { QuoteEngine } = require("../bot/quoteEngine");
const { CandidateIndex } = require("../bot/opportunityEngine");
const { sizeTrade, sizingSeed } = require("../bot/tradeSizer");
const { builderTip } = require("../execution/builderTip");
const { bn, address, serialize } = require("../bot/units");
const { checkSignal, abortable, abortError } = require("../bot/asyncControl");
const { FundingEngine } = require("./fundingEngine");
const { TriggerStatePredictor } = require("./statePredictor");
const { StateOverrideProvider } = require("./stateOverrideProvider");
const { MevShareClient } = require("./mevShareClient");

const FUNDED_IFACE = new utils.Interface([
  "function executeFundedArbitrage((address borrowToken,uint256 borrowAmount,(uint8 dexType,address router,address tokenIn,address tokenOut,uint256 minAmountOut,uint24 v3Fee,bytes32 balancerPoolId,int128 curveIndexIn,int128 curveIndexOut,bool curveUnderlying,address[] v2Path)[] steps,uint256 minProfit,string route) data)"
]);

function minBN(a,b){a=bn(a);b=bn(b);return a.lt(b)?a:b;}
function maxBN(a,b){a=bn(a);b=bn(b);return a.gt(b)?a:b;}

class BackrunEngine {
  constructor({
    coordinator,
    predictor,
    fundingEngine,
    mevShare,
    emit,
  } = {}) {
    if (!coordinator) throw new Error("BackrunEngine requires Coordinator");
    this.coordinator=coordinator;
    this.profile=coordinator.profile;
    this.provider=coordinator.provider;
    this.state=coordinator.state;
    this.ledger=coordinator.ledger;
    this.wallet=coordinator.wallet;
    this.emit=emit||coordinator.emit?.bind(coordinator)||(()=>{});
    this.predictor=predictor||new TriggerStatePredictor(this.provider,{timeoutMs:this.profile.backrun.traceTimeoutMs});
    this.funding=fundingEngine||new FundingEngine();
    this.mevShare=mevShare||new MevShareClient({
      apiUrl:this.profile.backrun.mevShareApiUrl,
      authKey:process.env.FLASHBOTS_AUTH_KEY,
      builders:this.profile.backrun.builders,
    });
    this.candidateIndex=new CandidateIndex();
    this.busy=false;
    this.activity={signatures:0,submissions:0};
    this.stats={
      triggers:0,
      statePredicted:0,
      affected:0,
      candidates:0,
      exactScreens:0,
      exactProfitable:0,
      sized:0,
      paperSimulated:0,
      liveSubmitted:0,
      rejected:0,
      lastReason:null,
      lastTrigger:null,
      lastLatencyMs:null,
    };
  }

  async initialize(signal){
    await abortable(this.coordinator.initialize(),signal);
    if(!this.coordinator.marketCache.head){
      const block=await abortable(pinnedBlock(this.provider),signal);
      const snapshot=await this.coordinator.marketCache.sync(block,{signal});
      this.coordinator.poolRegistry=snapshot.registry;
    }
  }

  tokenLimit(token){
    const meta=this.coordinator.tokens.get(token);
    const limit=this.profile.backrunLimits[meta.symbol];
    if(!limit)throw new Error(`No backrun limits for ${meta.symbol}`);
    return {
      symbol:meta.symbol,
      minInput:this.coordinator.tokens.parse(token,limit.minBorrow),
      maxInput:this.coordinator.tokens.parse(token,limit.maxBorrow),
      minimumProfit:this.coordinator.tokens.parse(token,limit.minimumProfit),
    };
  }

  async executorVersion(blockTag){
    try{return Number((await this.coordinator.contract.executorVersion({blockTag})).toString());}
    catch(_){return 0;}
  }

  async treasuryBalance(token,provider,blockTag){
    const erc20=new Contract(token,["function balanceOf(address) view returns(uint256)"],provider);
    return bn(await erc20.balanceOf(this.coordinator.contract.address,{blockTag}));
  }

  converter(registry,quoter,token){
    const borrow=address(token),weth=address(this.profile.tokens.WETH);
    if(borrow===weth)return {
      toBorrow:async value=>bn(value),
      toNative:async value=>bn(value),
    };
    const pool=registry.values().find(p=>p.dex==="uniswap_v2"&&[p.token0,p.token1].includes(borrow)&&[p.token0,p.token1].includes(weth));
    if(!pool)throw new Error("Missing exact Uniswap V2 gas valuation pool");
    const borrowToWeth=edge(pool,borrow),wethToBorrow=edge(pool,weth);
    return {
      toNative:async(value,block,signal)=>bn(value).lte(0)?bn(0):quoter.quoteLeg(borrowToWeth,value,block,"input",signal),
      toBorrow:async(value,block,signal)=>bn(value).lte(0)?bn(0):quoter.quoteLeg(wethToBorrow,value,block,"output",signal),
    };
  }

  heuristicGas(mode,hops){
    return bn((mode==="TREASURY"?100000:180000)+110000*hops);
  }

  async modeCosts({mode,quote,registry,quoter,block,signal,flashPremiumBps=0}){
    const converter=this.converter(registry,quoter,quote.route.borrowToken);
    const financingFee=mode==="AAVE_FLASH_LOAN"
      ? bn(quote.borrowAmount).mul(Number(flashPremiumBps)).add(5000).div(10000)
      : bn(0);
    const grossBorrow=bn(quote.expectedFinalAmount).sub(quote.borrowAmount).sub(financingFee);
    if(grossBorrow.lte(0))return null;
    const grossNative=await abortable(converter.toNative(grossBorrow,block.number,signal),signal);
    const gasUnits=this.heuristicGas(mode,quote.route.legs.length);
    const tip=builderTip({
      profitNativeWei:grossNative,
      baseFeePerGas:block.baseFeePerGas,
      gasLimit:gasUnits,
      maxBuilderShareBps:this.profile.maxBuilderShareBps,
      maxPriorityFeePerGas:utils.parseUnits("5","gwei"),
    });
    const gasNative=gasUnits.mul(tip.baseFeePerGas);
    const builderNative=tip.builderPaymentNativeWei;
    const aggregateBorrow=await abortable(converter.toBorrow(gasNative.add(builderNative),block.number,signal),signal);
    const gasBorrow=await abortable(converter.toBorrow(gasNative,block.number,signal),signal);
    return {
      financingFee,
      gasUnits,
      gasNative,
      builderNative,
      gasBorrow,
      builderBorrow:aggregateBorrow.sub(gasBorrow),
      tip,
    };
  }

  async fundingContext({route,registry,quoter,overlayProvider,block,signal}){
    const limits=this.tokenLimit(route.borrowToken);
    const aave=new AaveV2(overlayProvider,this.profile.flashloanProvider);
    let terms={premiumBps:0,availableLiquidity:bn(0)};
    if(this.profile.backrun.fundingModes.includes("AAVE_FLASH_LOAN")){
      try{terms=await abortable(aave.terms(route.borrowToken,block.number),signal);}
      catch(_){terms={premiumBps:0,availableLiquidity:bn(0)};}
    }
    let treasury=bn(0);
    const version=await this.executorVersion(block.number);
    if(version>=3&&this.profile.backrun.fundingModes.includes("TREASURY")){
      treasury=await abortable(this.treasuryBalance(route.borrowToken,overlayProvider,block.number),signal);
    }
    const capacity=maxBN(
      this.profile.backrun.fundingModes.includes("TREASURY")?treasury:0,
      this.profile.backrun.fundingModes.includes("AAVE_FLASH_LOAN")?terms.availableLiquidity:0
    );
    return {limits,terms,treasury,executorVersion:version,maxInput:minBN(limits.maxInput,capacity)};
  }

  async evaluate({route,amount,context,registry,quoter,block,signal}){
    checkSignal(signal);
    const quote=await quoter.quoteRoute(route,amount,block.number,signal);
    if(quote.expectedFinalAmount.lte(amount))return null;

    const modes=this.profile.backrun.fundingModes.filter(mode=>
      mode==="TREASURY"?context.executorVersion>=3:true
    );
    const gasCostByMode={},builderPaymentByMode={},details={};
    for(const mode of modes){
      const costs=await this.modeCosts({
        mode,quote,registry,quoter,block,signal,
        flashPremiumBps:context.terms.premiumBps,
      });
      if(!costs)continue;
      gasCostByMode[mode]=costs.gasBorrow;
      builderPaymentByMode[mode]=costs.builderBorrow;
      details[mode]=costs;
    }
    const funding=this.funding.choose({
      borrowAmount:amount,
      expectedFinalAmount:quote.expectedFinalAmount,
      treasuryBalance:context.treasury,
      flashLiquidity:context.terms.availableLiquidity,
      flashPremiumBps:context.terms.premiumBps,
      gasCostByMode,
      builderPaymentByMode,
      minimumRequiredProfit:context.limits.minimumProfit,
      allowedModes:modes,
    });
    if(!funding.mode||!funding.profitable)return null;
    const costs=details[funding.mode];
    const economics={
      borrowToken:route.borrowToken,
      borrowAmount:bn(amount),
      expectedFinalAmount:quote.expectedFinalAmount,
      flashloanFee:funding.financingFee,
      financingFee:funding.financingFee,
      fundingMode:funding.mode,
      grossProfit:funding.grossProfit,
      estimatedGasUnits:costs.gasUnits,
      estimatedGasCostNative:costs.gasNative,
      estimatedGasCostBorrowToken:funding.gasCostBorrowToken,
      estimatedBuilderPaymentNative:costs.builderNative,
      estimatedBuilderPaymentBorrowToken:funding.builderPaymentBorrowToken,
      expectedNetProfit:funding.expectedNetProfit,
      minimumRequiredProfit:context.limits.minimumProfit,
      profitable:funding.profitable,
      gasEstimation:"backrun_screening_heuristic",
    };
    return {quote,economics,funding,tip:costs.tip,context};
  }

  encode(mode,data){
    if(mode==="TREASURY")return FUNDED_IFACE.encodeFunctionData("executeFundedArbitrage",[data]);
    return this.coordinator.contract.interface.encodeFunctionData("initiateFlashLoan",[data]);
  }

  async prepareMode({mode,best,registry,quoter,overlayProvider,block,signal}){
    const converter=this.converter(registry,quoter,best.quote.route.borrowToken);
    const financingFee=mode==="AAVE_FLASH_LOAN"
      ? this.coordinator.flashloan.fee(best.quote.borrowAmount,best.context.terms.premiumBps)
      : bn(0);
    const threshold=best.context.limits.minimumProfit;
    const preliminary=quoter.buildData(best.quote,threshold,this.profile.slippageBps);
    const from=address(this.coordinator.operatorAddress);
    const initialTx={to:this.coordinator.contract.address,from,data:this.encode(mode,preliminary)};

    await abortable(overlayProvider.call(initialTx,block.number),signal);
    const estimate=bn(await abortable(overlayProvider.estimateGas(initialTx),signal));
    const gasLimit=estimate.mul(120).add(99).div(100);
    if(gasLimit.gt(this.profile.maxGasUnits))throw new Error("Estimated backrun gas exceeds limit");

    const grossBorrow=best.quote.expectedFinalAmount.sub(best.quote.borrowAmount).sub(financingFee);
    if(grossBorrow.lte(0))throw new Error("Funding cost consumes route surplus");
    const grossNative=await abortable(converter.toNative(grossBorrow,block.number,signal),signal);
    const tip=builderTip({
      profitNativeWei:grossNative,
      baseFeePerGas:block.baseFeePerGas,
      gasLimit,
      maxBuilderShareBps:this.profile.maxBuilderShareBps,
      maxPriorityFeePerGas:utils.parseUnits("5","gwei"),
    });
    const ceiling=utils.parseUnits(String(this.profile.gasCeilingGwei),"gwei");
    if(tip.maxFeePerGas.gt(ceiling))throw new Error("Gas price exceeds ceiling");

    const gasNative=gasLimit.mul(tip.baseFeePerGas);
    const builderNative=tip.builderPaymentNativeWei;
    const totalBorrow=await abortable(converter.toBorrow(gasNative.add(builderNative),block.number,signal),signal);
    const gasBorrow=await abortable(converter.toBorrow(gasNative,block.number,signal),signal);
    const builderBorrow=totalBorrow.sub(gasBorrow);
    const expectedNetProfit=grossBorrow.sub(gasBorrow).sub(builderBorrow);
    if(expectedNetProfit.lt(threshold)||expectedNetProfit.lte(0))throw new Error("Backrun not profitable after measured costs");

    const minProfit=threshold.add(gasBorrow).add(builderBorrow);
    const data=quoter.buildData(best.quote,minProfit,this.profile.slippageBps);
    const transaction={
      to:this.coordinator.contract.address,
      from,
      data:this.encode(mode,data),
      gasLimit,
      maxFeePerGas:tip.maxFeePerGas,
      maxPriorityFeePerGas:tip.maxPriorityFeePerGas,
    };
    await abortable(overlayProvider.call(transaction,block.number),signal);
    const economics={
      ...best.economics,
      flashloanFee:financingFee,
      financingFee,
      fundingMode:mode,
      grossProfit:grossBorrow,
      estimatedGasUnits:gasLimit,
      estimatedGasCostNative:gasNative,
      estimatedGasCostBorrowToken:gasBorrow,
      estimatedBuilderPaymentNative:builderNative,
      estimatedBuilderPaymentBorrowToken:builderBorrow,
      expectedNetProfit,
      minimumRequiredProfit:threshold,
      profitable:true,
      gasEstimation:"post_trigger_executor_estimate_with_margin",
    };
    return {mode,transaction,data,economics,tip};
  }

  async prepare(best,context){
    const {registry,quoter,overlayProvider,block,signal}=context;
    const modes=[];
    if(best.context.executorVersion>=3&&this.profile.backrun.fundingModes.includes("TREASURY")&&best.context.treasury.gte(best.quote.borrowAmount))modes.push("TREASURY");
    if(this.profile.backrun.fundingModes.includes("AAVE_FLASH_LOAN")&&best.context.terms.availableLiquidity.gte(best.quote.borrowAmount))modes.push("AAVE_FLASH_LOAN");
    const prepared=[];
    for(const mode of modes){
      try{prepared.push(await this.prepareMode({mode,best,registry,quoter,overlayProvider,block,signal}));}
      catch(err){if(err.name==="AbortError")throw err;}
    }
    prepared.sort((a,b)=>a.economics.expectedNetProfit.gt(b.economics.expectedNetProfit)?-1:1);
    if(!prepared.length)throw new Error("No funding mode survives exact executor simulation");
    return prepared[0];
  }

  async writePaper({trigger,best,prepared,block,prediction}){
    const route=best.quote.route;
    const id=crypto.randomUUID();
    const token=this.coordinator.tokens.get(route.borrowToken);
    const profitRecipient=await this.coordinator.contract.profitRecipient({blockTag:block.number});
    let record=await this.ledger.write({
      id,
      candidateId:route.id,
      mode:"PAPER",
      status:"DISCOVERED",
      strategyClass:"TRANSACTION_TRIGGERED_BACKRUN",
      trigger:{hash:trigger.hash,source:trigger.source,receivedAt:trigger.receivedAt},
      prediction:{affectedPools:prediction.affectedPools,touchedAccounts:prediction.touchedAccounts,traceType:prediction.traceType},
      fundingMode:prepared.mode,
      borrowToken:route.borrowToken,
      token,
      borrowAmount:best.quote.borrowAmount,
      flashloanPremium:prepared.economics.flashloanFee,
      route,
      swapData:prepared.data,
      economics:prepared.economics,
      stateBlock:block.number,
      stateBlockHash:block.hash,
      profitRecipient,
      weth:this.profile.tokens.WETH,
      discoveredAt:Date.now(),
      profileFingerprint:this.profile.fingerprint,
    });
    record=await this.ledger.write({
      ...record,
      status:"SIMULATED",
      simulation:{
        callStatic:true,
        postTriggerState:true,
        stateOverrides:true,
        bundle:false,
        bundleReason:"PAPER does not sign a backrun transaction; bundle simulation is intentionally not claimed",
      },
    });
    this.emit("opportunity",record);
    this.stats.paperSimulated++;
    return {executed:false,simulated:true,mode:"PAPER",trade:serialize(record)};
  }

  async submitLive({trigger,best,prepared,block,markCommitted,signal}){
    assertLiveAllowed(this.profile);
    const revision=this.state.revision;
    if(!this.state.canSign(revision))throw new Error("LIVE backrun is not armed");
    if(!this.wallet)throw new Error("Missing LIVE signer");
    if(this.ledger.pending().length)throw new Error("Pending submission must settle first");
    if(Date.now()-trigger.receivedAt>this.profile.backrun.eventTtlMs)throw abortError("Trigger expired before signing");

    const balance=await abortable(this.provider.getBalance(this.wallet.address),signal);
    if(balance.lt(prepared.transaction.gasLimit.mul(prepared.tip.maxFeePerGas)))throw new Error("Insufficient signer ETH for backrun gas");
    const nonce=await abortable(this.provider.getTransactionCount(this.wallet.address,"pending"),signal);
    checkSignal(signal);
    if(!this.state.canSign(revision))throw abortError("Trading mode changed before backrun signing");

    markCommitted?.();
    const signedBackrun=await abortable(this.wallet.signTransaction({
      ...prepared.transaction,
      nonce,
      chainId:this.profile.chainId,
      type:2,
    }),signal);
    this.activity.signatures++;

    const targetBlock=block.number+1;
    const bundle=this.mevShare.buildBundle({
      triggerHash:trigger.source==="mev_share"?trigger.hash:null,
      triggerRawTx:trigger.source==="public_pending"?trigger.rawTx:null,
      signedBackrun,
      targetBlock,
      maxBlock:targetBlock,
    });
    const simulation=await abortable(this.mevShare.simulate(bundle,{parentBlock:block.number,targetBlock}),signal);
    if(!simulation?.success)throw new Error("MEV-Share simulation rejected backrun bundle");

    const route=best.quote.route;
    const token=this.coordinator.tokens.get(route.borrowToken);
    const profitRecipient=await this.coordinator.contract.profitRecipient({blockTag:block.number});
    const txHash=utils.keccak256(signedBackrun);
    let record=await this.ledger.write({
      id:crypto.randomUUID(),
      candidateId:route.id,
      mode:"LIVE",
      status:"DISCOVERED",
      strategyClass:"TRANSACTION_TRIGGERED_BACKRUN",
      trigger:{hash:trigger.hash,source:trigger.source,receivedAt:trigger.receivedAt},
      fundingMode:prepared.mode,
      borrowToken:route.borrowToken,
      token,
      borrowAmount:best.quote.borrowAmount,
      flashloanPremium:prepared.economics.flashloanFee,
      route,
      swapData:prepared.data,
      economics:prepared.economics,
      stateBlock:block.number,
      stateBlockHash:block.hash,
      profitRecipient,
      weth:this.profile.tokens.WETH,
      discoveredAt:Date.now(),
      profileFingerprint:this.profile.fingerprint,
    });
    record=await this.ledger.write({...record,status:"SIMULATED",simulation:{bundle:true,mevShare:true,result:serialize(simulation)},txHash,targetBlock,nonce});
    record=await this.ledger.write({...record,status:"SUBMITTED"});
    if(!this.state.canSign(revision))throw abortError("LIVE stopped after bundle simulation");
    assertLiveAllowed(this.profile);
    this.activity.submissions++;
    const submission=await abortable(this.mevShare.send(bundle),signal);
    record=await this.ledger.write({...record,submissions:[{url:this.profile.backrun.mevShareApiUrl,bundleHash:submission.bundleHash}]});
    this.emit("trade_submitted",record);
    this.stats.liveSubmitted++;
    return {executed:false,status:"SUBMITTED",txHash,bundleHash:submission.bundleHash,reason:"receipt_pending"};
  }

  async handleTrigger({trigger,signal,markCommitted}){
    const started=Date.now();
    this.stats.triggers++;
    this.stats.lastTrigger=trigger?.hash||null;
    this.busy=true;
    try{
      if(!["PAPER","LIVE_RUNNING"].includes(this.state.state))return {executed:false,reason:"scanner_stopped_or_paused"};
      if(!trigger?.hash)throw new Error("Trigger hash required");
      if(Date.now()-(trigger.receivedAt||0)>this.profile.backrun.eventTtlMs)throw abortError("Trigger expired");
      await this.initialize(signal);
      const block=await abortable(pinnedBlock(this.provider),signal);
      const snapshot=await this.coordinator.marketCache.sync(block,{signal});
      this.coordinator.poolRegistry=snapshot.registry;
      const tracked=snapshot.registry.values().map(p=>p.poolAddress);
      const prediction=await abortable(this.predictor.predict(trigger,block.number,tracked),signal);
      if(!prediction.supported){
        if(this.profile.backrun.requireStatePrediction)throw new Error("Post-trigger state unavailable: "+prediction.reason);
        return {executed:false,reason:"post_trigger_state_unavailable"};
      }
      this.stats.statePredicted++;
      const affected=new Set(prediction.affectedPools.map(address));
      if(!affected.size)return {executed:false,reason:"trigger_does_not_touch_tracked_pool"};
      this.stats.affected+=affected.size;

      const overlayProvider=new StateOverrideProvider(this.provider,{blockTag:block.number,stateOverrides:prediction.stateOverrides});
      const overlayAdapters=createAdapters(overlayProvider,this.profile);
      const registry=new PoolRegistry(this.coordinator.tokens);
      for(const pool of snapshot.registry.values()){
        if(affected.has(address(pool.poolAddress))){
          const state=await abortable(overlayAdapters[pool.dex].getPoolState(pool,block.number),signal);
          registry.add({...pool,...state,stateBlock:block.number,stateTimestamp:Date.now()});
        }else registry.add({...pool,stateBlock:block.number,stateTimestamp:Date.now()});
      }
      const quoter=new QuoteEngine(overlayAdapters);
      quoter.beginBlock(block.hash+":"+trigger.hash);
      const borrowTokens=this.profile.backrunBorrowSymbols.map(s=>address(this.profile.tokens[s]));
      const candidates=this.candidateIndex
        .candidates(registry,borrowTokens,block.number,affected)
        .filter(route=>route.legs.some(leg=>affected.has(address(leg.poolAddress))))
        .slice(0,this.profile.backrun.maxCandidates);
      this.stats.candidates+=candidates.length;
      if(!candidates.length)return {executed:false,reason:"no_post_trigger_marginal_candidate"};

      const screened=[];
      for(const route of candidates){
        checkSignal(signal);
        try{
          const context=await this.fundingContext({route,registry,quoter,overlayProvider,block,signal});
          if(context.maxInput.lt(context.limits.minInput))continue;
          let seed=context.limits.minInput;
          try{seed=bn(sizingSeed(route,context.maxInput,context.terms.premiumBps));}catch(_){}
          if(seed.lt(context.limits.minInput))seed=context.limits.minInput;
          if(seed.gt(context.maxInput))seed=context.maxInput;
          this.stats.exactScreens++;
          const result=await this.evaluate({route,amount:seed,context,registry,quoter,block,signal});
          if(result){this.stats.exactProfitable++;screened.push({route,context,result});}
        }catch(err){if(err.name==="AbortError")throw err;}
      }
      if(!screened.length)return {executed:false,reason:"no_exact_profitable_post_trigger_candidate"};
      screened.sort((a,b)=>a.result.economics.expectedNetProfit.gt(b.result.economics.expectedNetProfit)?-1:1);

      const finalists=[];
      for(const item of screened.slice(0,this.profile.backrun.maxSizedCandidates)){
        checkSignal(signal);
        this.stats.sized++;
        const sized=await sizeTrade({
          route:item.route,
          minInput:item.context.limits.minInput,
          maxInput:item.context.maxInput,
          premiumBps:item.context.terms.premiumBps,
          samples:this.profile.sizingSamples,
          refinements:this.profile.sizingRefinements,
          signal,
          evaluate:amount=>this.evaluate({route:item.route,amount,context:item.context,registry,quoter,block,signal}),
        });
        if(sized?.economics?.profitable)finalists.push({route:item.route,context:item.context,...sized});
      }
      finalists.sort((a,b)=>a.economics.expectedNetProfit.gt(b.economics.expectedNetProfit)?-1:1);
      if(!finalists.length)return {executed:false,reason:"no_profitable_sized_backrun"};

      const best=finalists[0];
      const prepared=await this.prepare(best,{registry,quoter,overlayProvider,block,signal});
      if(this.state.state==="PAPER")return this.writePaper({trigger,best,prepared,block,prediction});
      return this.submitLive({trigger,best,prepared,block,markCommitted,signal});
    }catch(err){
      this.stats.rejected++;
      this.stats.lastReason=err.message;
      if(err.name!=="AbortError")this.emit("backrun_rejected",{triggerHash:trigger?.hash,reason:err.message});
      return {executed:false,reason:err.message};
    }finally{
      this.stats.lastLatencyMs=Date.now()-started;
      this.busy=false;
    }
  }

  status(){
    return serialize({
      enabled:this.profile.backrun.enabled,
      mode:this.profile.opportunityMode,
      busy:this.busy,
      borrowSymbols:this.profile.backrunBorrowSymbols,
      fundingModes:this.profile.backrun.fundingModes,
      stats:this.stats,
      prediction:this.predictor.status?.(),
      mevShare:this.mevShare.status?.(),
      activity:this.activity,
    });
  }
}

module.exports={BackrunEngine,FUNDED_IFACE};
