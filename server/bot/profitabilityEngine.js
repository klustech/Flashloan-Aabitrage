const {bn}=require('./units');
function profitability({borrowToken,borrowAmount,expectedFinalAmount,flashloanFee,estimatedGasUnits,gasCostNative,gasCostBorrowToken,builderPaymentNative,builderPaymentBorrowToken,minimumRequiredProfit}) {
  const grossProfit=bn(expectedFinalAmount).sub(borrowAmount).sub(flashloanFee);
  const expectedNetProfit=grossProfit.sub(gasCostBorrowToken).sub(builderPaymentBorrowToken);
  return {borrowToken,borrowAmount:bn(borrowAmount),expectedFinalAmount:bn(expectedFinalAmount),flashloanFee:bn(flashloanFee),grossProfit,
    estimatedGasUnits:bn(estimatedGasUnits),estimatedGasCostNative:bn(gasCostNative),estimatedGasCostBorrowToken:bn(gasCostBorrowToken),estimatedBuilderPaymentNative:bn(builderPaymentNative),estimatedBuilderPaymentBorrowToken:bn(builderPaymentBorrowToken),expectedNetProfit,minimumRequiredProfit:bn(minimumRequiredProfit),profitable:expectedNetProfit.gte(minimumRequiredProfit)&&expectedNetProfit.gt(0)};
}
module.exports={profitability};
