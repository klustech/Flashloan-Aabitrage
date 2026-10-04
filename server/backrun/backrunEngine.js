const crypto = require("crypto");
const { Contract, utils, providers } = require("ethers");
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
    traceProvider,
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
    this.traceProvider=traceProvider||new providers.JsonRpcProvider({
      url:process.env.BACKRUN_TRACE_RPC_URL||process.env.MAINNET_RPC_URL,
      timeout:Math.max(5000,this.profile.backrun.traceTimeoutMs+1000),
    },{name:"ethereum",chainId:1});
    this.predictor=predictor||new TriggerStatePredictor(this.traceProvider,{timeoutMs:this.profile.backrun.traceTimeoutMs});
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