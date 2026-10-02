const { Contract, constants } = require('ethers');
const { bn,address }=require('../bot/units');
const { swapStep }=require('./base');
const { mapLimit }=require('../bot/asyncControl');
const FACTORY=['function getPair(address,address) view returns (address)'];
const PAIR=['function token0() view returns(address)','function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function factory() view returns(address)'];
const ROUTER=['function getAmountsOut(uint256,address[]) view returns(uint256[])','function getAmountsIn(uint256,address[]) view returns(uint256[])','function factory() view returns(address)'];
class V2Adapter {
  constructor(provider,config,dex='uniswap_v2') {this.provider=provider;this.config=config;this.dex=dex;this.validations=new Set();this.factory=new Contract(address(config.factory),FACTORY,provider);this.router=new Contract(address(config.router),ROUTER,provider);}
  async discoverPools(tokens,blockTag,signal) {
    const pairs=[];
    for(let i=0;i<tokens.length;i++)for(let j=i+1;j<tokens.length;j++)pairs.push([tokens[i],tokens[j]]);
    const pools=await mapLimit(pairs,2,async pair=>{
      const poolAddress=await this.factory.getPair(...pair,{blockTag});
      if(address(poolAddress)===address(constants.AddressZero))return null;
      const pool={dex:this.dex,poolAddress,router:address(this.config.router),factory:address(this.config.factory),feeBps:30,stateBlock:blockTag,stateTimestamp:Date.now()};
      const state=await this.getPoolState(pool,blockTag);return {...pool,...state};
    },signal);
    return pools.filter(Boolean);
  }
  async getDynamicState(pool,blockTag) {
    const reserves=await new Contract(pool.poolAddress,PAIR,this.provider).getReserves({blockTag});
    return {reserve0:reserves[0],reserve1:reserves[1],stateBlock:blockTag,stateTimestamp:Date.now()};
  }
  async getPoolState(pool,blockTag) {
    const c=new Contract(pool.poolAddress,PAIR,this.provider);
    const [token0,token1,reserves,factory]=await Promise.all([c.token0({blockTag}),c.token1({blockTag}),c.getReserves({blockTag}),c.factory({blockTag})]);
    if(address(factory)!==address(this.config.factory))throw new Error('Pool factory mismatch');
    return {token0,token1,reserve0:reserves[0],reserve1:reserves[1],stateBlock:blockTag,stateTimestamp:Date.now()};
  }
  async validatePool(leg,blockTag) {
    const key=`${blockTag}:${leg.poolAddress}:${leg.tokenIn}:${leg.tokenOut}:${leg.router}:${leg.factory}`;if(this.validations.has(key))return;
    if(address(leg.router)!==address(this.config.router))throw new Error('Router mismatch');
    const [factory,pool]=await Promise.all([this.router.factory({blockTag}),this.factory.getPair(leg.tokenIn,leg.tokenOut,{blockTag})]);
    if(address(factory)!==address(this.config.factory)||address(pool)!==address(leg.poolAddress))throw new Error('Exact V2 pool mismatch');
    if(this.validations.size>5000)this.validations.clear();this.validations.add(key);
  }
  async quoteExactInput(leg,amount,blockTag) {await this.validatePool(leg,blockTag);const result=await this.router.getAmountsOut(amount,[leg.tokenIn,leg.tokenOut],{blockTag});return bn(result[1]);}
  async quoteExactOutput(leg,amount,blockTag) {await this.validatePool(leg,blockTag);const result=await this.router.getAmountsIn(amount,[leg.tokenIn,leg.tokenOut],{blockTag});return bn(result[0]);}
  buildSwapStep(leg,output,slippageBps) {return swapStep(leg,output,slippageBps,this.dex==='sushiswap_v2'?2:0);}
}
module.exports={V2Adapter};
