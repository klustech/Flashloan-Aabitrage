const {bn,ceilDiv}=require('../bot/units');
function builderTip({profitNativeWei,baseFeePerGas,gasLimit,maxBuilderShareBps,maxPriorityFeePerGas}) {
  const nextBaseFee=ceilDiv(bn(baseFeePerGas).mul(9),8);
  const budget=bn(profitNativeWei).mul(maxBuilderShareBps).div(10000);
  let priority=budget.div(gasLimit);if(priority.gt(maxPriorityFeePerGas))priority=bn(maxPriorityFeePerGas);
  return {baseFeePerGas:nextBaseFee,maxPriorityFeePerGas:priority,maxFeePerGas:nextBaseFee.add(priority),builderPaymentNativeWei:priority.mul(gasLimit),builderBudgetNativeWei:budget};
}
module.exports={builderTip};
