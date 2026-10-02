const {V2Adapter}=require('./uniswapV2');
const {SushiV2Adapter}=require('./sushiV2');
const {V3Adapter}=require('./uniswapV3');
const {PancakeV3Adapter}=require('./pancakeV3');
function createAdapters(provider,profile){return {uniswap_v2:new V2Adapter(provider,profile.routers.uniswap_v2),sushiswap_v2:new SushiV2Adapter(provider,profile.routers.sushiswap_v2),uniswap_v3:new V3Adapter(provider,profile.routers.uniswap_v3),pancake_v3:new PancakeV3Adapter(provider,profile.routers.pancake_v3)};}
module.exports={createAdapters};
