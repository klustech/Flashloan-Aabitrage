const { constants } = require('ethers');
const { bn, address } = require('../bot/units');
function swapStep(leg,amountOut,slippageBps,dexType) {
  const minAmountOut=bn(amountOut).mul(10000-slippageBps).div(10000);
  if(minAmountOut.lte(0))throw new Error('Zero minimum swap output');
  return {dexType,router:address(leg.router),tokenIn:leg.tokenIn,tokenOut:leg.tokenOut,minAmountOut,
    v3Fee:leg.feeTier||0,balancerPoolId:leg.poolId||constants.HashZero,curveIndexIn:leg.curveIndexIn||0,curveIndexOut:leg.curveIndexOut||0,curveUnderlying:leg.curveUnderlying||false,
    v2Path:leg.protocolVersion===2?[leg.tokenIn,leg.tokenOut]:[]};
}
module.exports={swapStep};
