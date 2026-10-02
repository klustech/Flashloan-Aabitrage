const {V3Adapter}=require('./uniswapV3');
class PancakeV3Adapter extends V3Adapter {constructor(provider,config){super(provider,config,'pancake_v3');}}
module.exports={PancakeV3Adapter};
