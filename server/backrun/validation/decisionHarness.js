// Runs the production pre-signing decision (BackrunTransactionBuilder.prepare)
// against deterministic inputs, with no RPC. A stress gate is only meaningful
// if the code that decides to sign is the code under test, not a re-derivation.
const { utils } = require("ethers");
const { BackrunTransactionBuilder } = require("../backrunTransactionBuilder");
const { bn } = require("../../bot/units");

const EXECUTOR = new utils.Interface(require("../../abis/ArbitrageFlashloan.json"));
const WETH = "0x" + "11".repeat(20), EXECUTOR_ADDRESS = "0x" + "22".repeat(20), OPERATOR = "0x" + "33".repeat(20);

function harnessProfile({ minimumWei, maxBuilderShareBps = 1500, gasCeilingGwei = "50", maxGasUnits = 1500000 }) {
  return { tokens: { WETH }, maxBuilderShareBps, gasCeilingGwei, maxGasUnits, slippageBps: 0,
    backrun: { fundingMode: "adaptive", minimumProfitBySymbol: { WETH: utils.formatEther(bn(minimumWei)) } } };
}

// Returns { accepted, reason, transaction, economics } for one scenario.
async function productionDecision({ grossProfitWei, fundingCostWei = 0, estimatedGas, baseFeePerGas, minimumWei,
  maxBuilderShareBps, gasCeilingGwei, maxGasUnits, mode = "CAPITAL" }) {
  const profile = harnessProfile({ minimumWei, maxBuilderShareBps, gasCeilingGwei, maxGasUnits });
  const tokens = { get: () => ({ symbol: "WETH", decimals: 18 }), parse: (_t, value) => utils.parseEther(value) };
  const contract = { address: EXECUTOR_ADDRESS, interface: EXECUTOR };
  const builder = new BackrunTransactionBuilder({ contract, tokens, profile, operatorAddress: OPERATOR });
  const step = { dexType: 0, router: "0x" + "44".repeat(20), tokenIn: WETH, tokenOut: WETH, minAmountOut: 1, v3Fee: 0,
    balancerPoolId: utils.hexZeroPad("0x", 32), curveIndexIn: 0, curveIndexOut: 0, curveUnderlying: false, v2Path: [] };
  const context = { id: "harness", simulationBlock: 1, assertActive() {},
    provider: { call: async () => "0x", estimateGas: async () => bn(estimatedGas) },
    quoter: { buildData: (quote, minProfit) => ({ borrowToken: WETH, borrowAmount: quote.borrowAmount, steps: [step],
      minProfit: bn(minProfit), route: "harness" }) } };
  // WETH settlement: native and borrow-token values are identical.
  const postQuoter = { toNative: async (_t, v) => bn(v), nativeCost: async (_t, v) => bn(v) };
  const candidate = { quote: { route: { borrowToken: WETH }, borrowAmount: bn(1) }, grossProfit: bn(grossProfitWei),
    funding: { mode, fundingCost: bn(fundingCostWei), flashFee: bn(fundingCostWei), capitalAvailable: bn(1) },
    flashloanTerms: { availableLiquidity: bn(1) }, block: { baseFeePerGas: bn(baseFeePerGas) } };
  try {
    const prepared = await builder.prepare(candidate, context, postQuoter);
    return { accepted: true, reason: null, transaction: prepared.transaction, economics: prepared.economics };
  } catch (error) {
    return { accepted: false, reason: error.message };
  }
}

module.exports = { productionDecision };
