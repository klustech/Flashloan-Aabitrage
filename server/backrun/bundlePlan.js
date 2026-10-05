const { utils } = require("ethers");

function buildBackrunBundlePlan({
  trigger,
  backrunTransaction,
  stateBlock,
  targetBlock,
  funding,
  paperOnly,
}) {
  if (!trigger?.hash) throw new Error("trigger hash required");
  if (!Number.isSafeInteger(stateBlock) || !Number.isSafeInteger(targetBlock) || targetBlock <= stateBlock)
    throw new Error("invalid bundle block");

  const plan = {
    strategy: "TRANSACTION_TRIGGERED_BACKRUN",
    triggerHash: trigger.hash,
    stateBlock,
    targetBlock,
    fundingMode: funding?.mode,
    backrunTransaction,
    paperOnly: Boolean(paperOnly),
  };

  if (paperOnly) {
    return {
      ...plan,
      signedBundle: null,
      simulationRequirement: "trigger+backrun bundle must be simulated before LIVE",
    };
  }

  if (!trigger.rawTx) throw new Error("LIVE backrun requires raw trigger transaction");
  if (!backrunTransaction?.signedTx) throw new Error("LIVE backrun requires signed arbitrage transaction");
  const rawTriggerHash = utils.keccak256(trigger.rawTx).toLowerCase();
  if (String(trigger.hash).toLowerCase() !== rawTriggerHash)
    throw new Error("Trigger hash does not match raw transaction");

  return {
    ...plan,
    signedBundle: [trigger.rawTx, backrunTransaction.signedTx],
    triggerTxHash: rawTriggerHash,
  };
}

module.exports = { buildBackrunBundlePlan };
