const {Contract}=require('ethers');
const {bn,address}=require('../bot/units');
class AaveV2 {
  constructor(provider,config){if(config.version!==2)throw new Error('Executor requires Aave V2');this.provider=provider;this.config=config;this.pool=new Contract(address(config.lendingPool),['function FLASHLOAN_PREMIUM_TOTAL() view returns(uint256)','function getReserveData(address) view returns(tuple(uint256 configuration,uint128 liquidityIndex,uint128 variableBorrowIndex,uint128 currentLiquidityRate,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint8 id))'],provider);}
  async terms(token,blockTag){
    const [premiumBps,reserve]=await Promise.all([this.pool.FLASHLOAN_PREMIUM_TOTAL({blockTag}),this.pool.getReserveData(token,{blockTag})]);
    // Aave V2 ReserveConfiguration: active bit 56, frozen bit 57; paused is pool-wide.
    const config=bn(reserve.configuration);if(!config.shr(56).and(1).eq(1))throw new Error('Aave reserve inactive');
    const liquidity=await new Contract(token,['function balanceOf(address) view returns(uint256)'],this.provider).balanceOf(reserve.aTokenAddress,{blockTag});
    return {premiumBps:Number(premiumBps),availableLiquidity:bn(liquidity),aTokenAddress:reserve.aTokenAddress};
  }
  fee(amount,premiumBps){return bn(amount).mul(premiumBps).add(5000).div(10000);}
}
module.exports={AaveV2};
