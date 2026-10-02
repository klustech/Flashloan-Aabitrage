const {Contract,constants}=require('ethers');
const {bn,address}=require('../bot/units');
const {swapStep}=require('./base');
const FACTORY=['function getPool(address,address,uint24) view returns(address)'];
const POOL=['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)','function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)','function liquidity() view returns(uint128)'];
const QUOTER_V1=['function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns(uint256)','function quoteExactOutputSingle(address,address,uint24,uint256,uint160) returns(uint256)','function factory() view returns(address)'];
const QUOTER_V2=['function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160,uint32,uint256 gasEstimate)','function quoteExactOutputSingle(tuple(address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountIn,uint160,uint32,uint256 gasEstimate)','function factory() view returns(address)'];
class V3Adapter {
  constructor(provider,config,dex='uniswap_v3'){this.provider=provider;this.config=config;this.dex=dex;this.validations=new Set();this.factory=new Contract(address(config.factory),FACTORY,provider);this.router=new Contract(address(config.router),['function factory() view returns(address)'],provider);this.quoter=new Contract(address(config.quoter),config.quoterVersion===2?QUOTER_V2:QUOTER_V1,provider);}
  async discoverPools(tokens,blockTag){
    const pools=[];
    for(let i=0;i<tokens.length;i++)for(let j=i+1;j<tokens.length;j++)for(const feeTier of this.config.feeTiers){
      const poolAddress=await this.factory.getPool(tokens[i],tokens[j],feeTier,{blockTag});
      if(address(poolAddress)===address(constants.AddressZero))continue;
      const pool={dex:this.dex,poolAddress,router:address(this.config.router),factory:address(this.config.factory),quoter:address(this.config.quoter),feeTier,stateBlock:blockTag,stateTimestamp:Date.now()};
      const state=await this.getPoolState(pool,blockTag);if(bn(state.liquidity).gt(0))pools.push({...pool,...state});
    }
    return pools;
  }
  async getPoolState(pool,blockTag){
    const c=new Contract(pool.poolAddress,POOL,this.provider);
    const [token0,token1,factory,feeTier,slot,liquidity]=await Promise.all([c.token0({blockTag}),c.token1({blockTag}),c.factory({blockTag}),c.fee({blockTag}),c.slot0({blockTag}),c.liquidity({blockTag})]);
    if(address(factory)!==address(this.config.factory)||Number(feeTier)!==pool.feeTier)throw new Error('V3 pool metadata mismatch');
    return {token0,token1,sqrtPriceX96:slot[0],liquidity,stateBlock:blockTag,stateTimestamp:Date.now()};
  }
  async validatePool(leg,blockTag){
    const key=`${blockTag}:${leg.poolAddress}:${leg.tokenIn}:${leg.tokenOut}:${leg.feeTier}:${leg.router}:${leg.factory}:${leg.quoter}`;if(this.validations.has(key))return;
    if(address(leg.router)!==address(this.config.router)||address(leg.quoter)!==address(this.config.quoter))throw new Error('V3 adapter mismatch');
    const [factory,quoteFactory,pool]=await Promise.all([this.router.factory({blockTag}),this.quoter.factory({blockTag}),this.factory.getPool(leg.tokenIn,leg.tokenOut,leg.feeTier,{blockTag})]);
    if(address(factory)!==address(this.config.factory)||address(quoteFactory)!==address(this.config.factory)||address(pool)!==address(leg.poolAddress))throw new Error('Exact V3 pool mismatch');
    if(this.validations.size>5000)this.validations.clear();this.validations.add(key);
  }
  async quoteExactInput(leg,amount,blockTag){
    await this.validatePool(leg,blockTag);
    if(this.config.quoterVersion===2){const q=await this.quoter.callStatic.quoteExactInputSingle({tokenIn:leg.tokenIn,tokenOut:leg.tokenOut,amountIn:amount,fee:leg.feeTier,sqrtPriceLimitX96:0},{blockTag});return bn(q[0]);}
    return bn(await this.quoter.callStatic.quoteExactInputSingle(leg.tokenIn,leg.tokenOut,leg.feeTier,amount,0,{blockTag}));
  }
  async quoteExactOutput(leg,amount,blockTag){
    await this.validatePool(leg,blockTag);
    if(this.config.quoterVersion===2){const q=await this.quoter.callStatic.quoteExactOutputSingle({tokenIn:leg.tokenIn,tokenOut:leg.tokenOut,amount,fee:leg.feeTier,sqrtPriceLimitX96:0},{blockTag});return bn(q[0]);}
    return bn(await this.quoter.callStatic.quoteExactOutputSingle(leg.tokenIn,leg.tokenOut,leg.feeTier,amount,0,{blockTag}));
  }
  buildSwapStep(leg,output,slippageBps){return swapStep(leg,output,slippageBps,this.dex==='pancake_v3'?5:1);}
}
module.exports={V3Adapter};
