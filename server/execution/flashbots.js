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
function validateBackrunBundleSimulation(simulation,{triggerRawTx,backrunSignedTx,stateBlock,maxGasUnits}) {
  if(!simulation||simulation.error||simulation.firstRevert||!Array.isArray(simulation.results)||simulation.results.length!==2)
    throw new Error('Backrun bundle simulation failed/missing');
  if(Number(simulation.stateBlockNumber)!==stateBlock)throw new Error('Backrun bundle simulation state block mismatch');
  const [trigger,backrun]=simulation.results;
  const triggerHash=utils.keccak256(triggerRawTx).toLowerCase();
  const backrunHash=utils.keccak256(backrunSignedTx).toLowerCase();
  if(trigger.error||trigger.revert||trigger.txHash?.toLowerCase()!==triggerHash)throw new Error('Trigger transaction failed/mismatched');
  if(backrun.error||backrun.revert||backrun.txHash?.toLowerCase()!==backrunHash)throw new Error('Backrun transaction failed/mismatched');
  const gasUsed=bn(backrun.gasUsed),triggerGasUsed=bn(trigger.gasUsed||0);
  if(triggerGasUsed.lte(0))throw new Error('Trigger gas outside limits');
  if(gasUsed.lte(0)||gasUsed.gt(maxGasUnits))throw new Error('Backrun gas outside limits');
  if(!bn(simulation.totalGasUsed).eq(triggerGasUsed.add(gasUsed)))throw new Error('Backrun bundle gas accounting mismatch');
  if(backrun.ethSentToCoinbase===undefined||!bn(backrun.ethSentToCoinbase).isZero())throw new Error('Unexpected direct coinbase payment');
  return {gasUsed,triggerGasUsed,builderDirectPaymentNative:bn(0),triggerHash,backrunHash};
}
module.exports={validateBundleSimulation,validateBackrunBundleSimulation};
