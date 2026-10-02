const {V2Adapter}=require('./uniswapV2');
class SushiV2Adapter extends V2Adapter {constructor(provider,config){super(provider,config,'sushiswap_v2');}}
module.exports={SushiV2Adapter};
