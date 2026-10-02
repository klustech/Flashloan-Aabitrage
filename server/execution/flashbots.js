const {utils}=require('ethers');
const {bn}=require('../bot/units');
function validateBundleSimulation(simulation,{signedTx,stateBlock,maxGasUnits}) {
  if(!simulation||simulation.error||simulation.firstRevert||!Array.isArray(simulation.results)||simulation.results.length!==1)throw new Error('Bundle simulation failed/missing');
  if(Number(simulation.stateBlockNumber)!==stateBlock)throw new Error('Bundle simulation state block mismatch');
  const result=simulation.results[0];
  if(result.error||result.revert||result.txHash?.toLowerCase()!==utils.keccak256(signedTx).toLowerCase())throw new Error('Bundle transaction failed/mismatched');
  const gasUsed=bn(result.gasUsed);if(gasUsed.lte(0)||gasUsed.gt(maxGasUnits))throw new Error('Bundle gas outside limits');
  if(!bn(simulation.totalGasUsed).eq(gasUsed))throw new Error('Bundle gas accounting mismatch');
  // The executor never transfers ETH directly to coinbase. Priority fees are
  // already included in effective gas cost; coinbaseDiff must not be charged twice.
  if(result.ethSentToCoinbase===undefined||!bn(result.ethSentToCoinbase).isZero())throw new Error('Unexpected direct coinbase payment');
  return {gasUsed,builderDirectPaymentNative:bn(0)};
}
module.exports={validateBundleSimulation};
