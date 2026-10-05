const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { utils, BigNumber } = require("ethers");
const { measuredRows } = require("../../server/backrun/validation/economics");
const { analyzeSizeCurve } = require("../../server/backrun/validation/sizeSweep");
const { gasStress } = require("../../server/backrun/validation/gasStress");
const { builderCompetition, haircutRow } = require("../../server/backrun/validation/builderCompetition");
const { fundingParity } = require("../../server/backrun/validation/fundingParity");
const { outputHaircut, liquidityEffects } = require("../../server/backrun/validation/slippageStress");
const { buildManifest, writeEvidence, readEvidence, manifestProblems } = require("../../server/backrun/validation/validationEvidence");
const { productionProfile } = require("../../server/config/productionProfile");

const gwei = v => utils.parseUnits(String(v), "gwei"), ether = v => utils.parseEther(String(v));
const PROFILE = { maxBuilderShareBps: 1500, gasCeilingGwei: "50", maxGasUnits: 1500000 };
const MIN = ether("0.00001");
// Shaped on the measured 26115911 rows: ~0.5 WETH, ~0.0037 WETH gross, ~0.23 gwei.
function row({ mode = "CAPITAL", amount = "0.5", gross = "0.0037", gas = 417362, fee = "0", base = "0.2", priority = "0.033", bps = 10000, trigger = "0xaa" } = {}) {
  const amountIn = ether(amount), g = ether(gross), flashFee = ether(fee), price = gwei(base).add(gwei(priority));
  const withdrawn = g.sub(flashFee), gasCost = price.mul(gas);
  return { triggerHash: trigger, blockNumber: 26115911, fundingMode: mode, amountIn: amountIn.toString(), priorityFeeBps: bps,
    grossBeforeFundingFee: g.toString(), flashloanFee: flashFee.toString(), profitWithdrawn: withdrawn.toString(),
    gasUsed: String(gas), effectiveGasPrice: price.toString(), priorityFeePerGas: gwei(priority).toString(),
    gasCostNative: gasCost.toString(), netAfterGasNative: withdrawn.sub(gasCost).toString(),
    executionSucceeded: true, canonicalReceiptsVerified: true, sameBlock: true, principalPreserved: true };
}
const rows = list => measuredRows({ results: list });

test("size sweep finds the net-optimal size, the unprofitable edge and checks the engine selection", () => {
  const curve = [["0.1", "0.0008"], ["0.25", "0.0019"], ["0.5", "0.0037"], ["1", "0.0030"], ["2", "0.0004"], ["5", "0.0000001"]];
  const measured = rows(curve.map(([amount, gross]) => row({ amount, gross })));
  const ok = analyzeSizeCurve(measured, { fundingMode: "CAPITAL", selectedAmount: ether("0.5") });
  assert.equal(ok.optimalAmount, ether("0.5").toString());
  assert.equal(ok.firstUnprofitableAmount, ether("5").toString());
  assert.equal(ok.maximumProfitableAmount, ether("2").toString());
  assert.ok(BigNumber.from(ok.marginalProfitAtNextSize).lt(0));
  assert.equal(ok.passed, true);
  const poor = analyzeSizeCurve(measured, { fundingMode: "CAPITAL", selectedAmount: ether("1") });
  assert.equal(poor.passed, false); assert.equal(poor.reason, "selected_size_below_tolerance");
  assert.equal(analyzeSizeCurve(measured, { fundingMode: "CAPITAL" }).reason, "engine_selected_amount_not_recorded");
  const rising = rows([["0.1", "0.001"], ["0.5", "0.003"]].map(([amount, gross]) => row({ amount, gross })));
  assert.equal(analyzeSizeCurve(rising, { fundingMode: "CAPITAL", selectedAmount: ether("0.5") }).reason, "optimum_at_grid_edge_extend_grid");
});

test("size gate on the measured 26115902 sweep: rejected larger sizes close the curve, off-grid selections are interpolated", () => {
  // CAPITAL net (ETH) per size at 0 bps and 10000 bps priority, as measured; 0.2-1.0 WETH quote-rejected.
  const net = { 0: [["0.01", "-0.000011135605393475"], ["0.03", "0.00001815334508125"], ["0.06", "0.000044797942853434"],
      ["0.06080858030334331", "0.000045226936492378"], ["0.1", "0.000047375928957894"]],
    10000: [["0.01", "-0.000060393617059845"], ["0.03", "-0.00003110311349342"], ["0.06", "-0.000004458205102896"],
      ["0.06080858030334331", "-0.000004032938884032"], ["0.1", "-0.000003079205790836"]] };
  const measured = Object.entries(net).flatMap(([bps, list]) => list.map(([amount, n]) => ({ fundingMode: "CAPITAL", priorityFeeBps: Number(bps),
    amountIn: ether(amount), netAfterGasNative: ether(n), gasUsed: BigNumber.from(317161) })));
  const rejectedAmounts = ["0.2", "0.5", "1.0"].map(a => ether(a).toString());
  const selected = ether("0.083518132180718573");
  const fee0 = analyzeSizeCurve(measured, { fundingMode: "CAPITAL", priorityFeeBps: 0, selectedAmount: selected, rejectedAmounts });
  assert.equal(fee0.optimumAtGridEdge, false, "0.2 WETH was evaluated and rejected");
  assert.equal(fee0.firstUnprofitableAmount, ether("0.2").toString());
  assert.equal(fee0.selection.estimate, "interpolated");
  assert.ok(fee0.selection.ratioBps >= 9500 && fee0.passed, JSON.stringify(fee0.selection));
  const fee10000 = analyzeSizeCurve(measured, { fundingMode: "CAPITAL", priorityFeeBps: 10000, selectedAmount: selected, rejectedAmounts });
  assert.deepEqual([fee10000.applicable, fee10000.passed, fee10000.reason], [false, true, "no_profitable_size_at_fee"]);
  // Without the rejected sizes the same curve is ambiguous at its edge.
  assert.equal(analyzeSizeCurve(measured, { fundingMode: "CAPITAL", priorityFeeBps: 0, selectedAmount: selected }).reason, "optimum_at_grid_edge_extend_grid");
  // A selection outside the measured range cannot be judged.
  assert.equal(analyzeSizeCurve(measured, { fundingMode: "CAPITAL", priorityFeeBps: 0, selectedAmount: ether("0.15"), rejectedAmounts }).reason,
    "engine_selected_amount_outside_measured_curve");
  // A poor off-grid choice still fails.
  assert.equal(analyzeSizeCurve(measured, { fundingMode: "CAPITAL", priorityFeeBps: 0, selectedAmount: ether("0.02"), rejectedAmounts }).reason,
    "selected_size_below_tolerance");
});

test("gas stress: production never accepts a scenario that realises less than the minimum", async () => {
  // A healthy edge and a marginal one (survives 1x gas, not 10x).
  const report = await gasStress(rows([row(), row({ mode: "FLASH_LOAN", fee: "0.00047", gas: 643315 }), row({ gross: "0.0003", trigger: "0xbb" })]),
    { minimumWei: MIN, profile: PROFILE });
  assert.equal(report.passed, true); assert.equal(report.unsafeScenarios, 0);
  const all = report.results.flatMap(r => r.scenarios);
  assert.ok(all.some(s => s.productionAccepted), "some scenarios stay tradeable");
  assert.ok(all.some(s => !s.productionAccepted), "hostile gas is rejected before signing");
  const marginal = report.results.find(r => r.triggerHash === "0xbb").scenarios;
  assert.equal(marginal.find(s => s.priceMultiplierBps === 10000 && s.usageMultiplierBps === 10000).productionAccepted, true);
  assert.equal(marginal.find(s => s.priceMultiplierBps === 100000).productionAccepted, false);
  assert.ok(all.some(s => s.outOfGasRevert), "usage beyond the signed limit reverts instead of settling");
});

test("gas stress detects a signer that ignores gas costs", async () => {
  const reckless = async () => ({ accepted: true, transaction: { gasLimit: BigNumber.from(10_000_000),
    maxPriorityFeePerGas: gwei("500"), maxFeePerGas: gwei("1000") } });
  const report = await gasStress(rows([row()]), { minimumWei: MIN, profile: PROFILE, decide: reckless });
  assert.equal(report.passed, false); assert.ok(report.unsafeScenarios > 0);
});

test("builder haircut reports the maximum competitive bid and production keeps retained >= minimum", async () => {
  const [r] = rows([row()]);
  const h = haircutRow(r, { minimumWei: MIN });
  const surplus = BigNumber.from(h.surplus);
  assert.equal(h.maxCompetitiveShareBps, surplus.sub(MIN).mul(10000).div(surplus).toNumber());
  assert.equal(h.scenarios.find(s => s.builderShareBps === 0).retainedProfit, h.surplus);
  const report = await builderCompetition([r], { minimumWei: MIN, profile: PROFILE });
  assert.equal(report.passed, true);
  const greedy = async () => ({ accepted: true, economics: { expectedNetProfit: "1" } });
  assert.equal((await builderCompetition([r], { minimumWei: MIN, profile: PROFILE, decide: greedy })).passed, false);
});

test("funding parity explains the CAPITAL/FLASH_LOAN difference exactly or fails", () => {
  const pair = [row(), row({ mode: "FLASH_LOAN", fee: "0.00047", gas: 643315 })];
  assert.equal(fundingParity(rows(pair)).passed, true);
  const skewed = [row(), row({ mode: "FLASH_LOAN", gross: "0.0036", fee: "0.00047", gas: 643315 })];
  const bad = fundingParity(rows(skewed));
  assert.equal(bad.passed, false); assert.ok(bad.pairs[0].problems.includes("swap output differs between funding modes"));
  const tampered = rows(pair); tampered[1].netAfterGasNative = tampered[1].netAfterGasNative.add(1);
  assert.ok(fundingParity(tampered).pairs[0].problems.includes("net difference not explained by flash fee and gas"));
  assert.equal(fundingParity(rows([row()])).reason, "no_same_state_capital_flash_pairs");
});

test("slippage haircuts turn into rejects and liquidity effects keep price while thinning depth", () => {
  const [scen] = outputHaircut(rows([row()]), { minimumWei: MIN });
  const outcomes = scen.scenarios.map(s => s.expectedOutcome);
  assert.equal(outcomes[0], "EXECUTE"); assert.equal(outcomes.at(-1), "REJECT_OR_REVERT");
  const [v2, v3] = liquidityEffects([
    { poolAddress: "0x01", protocolVersion: 2, token0: "a", token1: "b", reserve0: "1000", reserve1: "4000" },
    { poolAddress: "0x02", protocolVersion: 3, token0: "a", token1: "b", sqrtPriceX96: "79228162514264337593543950336", tick: 0, liquidity: "1000000" }], 5000);
  assert.deepEqual(v2.reserves.map(String), ["500", "2000"]);
  assert.equal(v3.liquidity.toString(), "500000"); assert.equal(v3.sqrtPriceX96.toString(), "79228162514264337593543950336");
  assert.throws(() => liquidityEffects([], 0));
});

test("validation evidence is bound to the manifest identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validation-")), env = { BACKRUN_VALIDATION_DIR: dir };
  const manifest = buildManifest(productionProfile({}));
  assert.equal(manifest.solcVersion, "0.8.20"); assert.equal(manifest.executorVersion, 4);
  assert.ok(!manifestProblems({ ...manifest, gitDirty: false }).length);
  assert.ok(manifestProblems({ ...manifest, gitDirty: false, solcVersion: "0.8.37" }).some(p => p.includes("solc")));
  writeEvidence("gas-stress", { passed: true }, manifest, { env });
  assert.equal(readEvidence("gas-stress", { manifest, env }).ok, true);
  assert.match(readEvidence("gas-stress", { manifest: { ...manifest, manifestId: "0xother" }, env }).reason, /different code/);
  assert.match(readEvidence("gas-stress", { manifest, env, maxAgeMs: 1, now: () => Date.now() + 10 }).reason, /older/);
  assert.match(readEvidence("missing", { manifest, env }).reason, /missing/);
  assert.equal(buildManifest(productionProfile({}), { env: { MAINNET_RPC_URL: "https://eth.example.com/v2/SECRETKEY" } }).archiveProvider, "eth.example.com");
});

test("economic gates CLI turns measured reports into manifest-bound evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-")), trigger = "0x" + "cd".repeat(32);
  const sizes = [["0.1", "0.0008"], ["0.25", "0.0019"], ["0.5", "0.0037"], ["1", "0.003"], ["2", "0.0004"]];
  // Reports carry the executor identity the replay generators stamp on them.
  const { EXECUTOR_VERSION } = require("../../server/config/executorVersion");
  const { executorCodeHash } = require("../../server/backrun/validation/validationEvidence");
  const identity = { executorVersion: EXECUTOR_VERSION, executorArtifactHash: executorCodeHash() };
  const sweep = { kind: "LOCAL_EXECUTOR_SIZE_FEE_SWEEP", ...identity, status: "finished", triggerHash: trigger, blockNumber: 26115911,
    results: sizes.flatMap(([amount, gross]) => [row({ amount, gross, trigger }),
      row({ mode: "FLASH_LOAN", amount, gross, fee: (Number(amount) * 0.0009).toFixed(8), gas: 643315, trigger })]) };
  const batch = { kind: "LOCAL_EXECUTOR_HISTORICAL_BATCH", ...identity, status: "finished", results: [{ triggerHash: trigger, blockNumber: 26115911, transactionIndex: 24,
    executions: [row({ amount: "0.5", gross: "0.0037", trigger }), row({ mode: "FLASH_LOAN", amount: "0.5", gross: "0.0037", fee: "0.00045", gas: 643315, trigger })] }] };
  fs.writeFileSync(path.join(dir, "sweep.json"), JSON.stringify(sweep)); fs.writeFileSync(path.join(dir, "batch.json"), JSON.stringify(batch));
  const env = { BACKRUN_VALIDATION_DIR: path.join(dir, "v"), BACKRUN_EVIDENCE_MANIFEST: path.join(dir, "manifest.json"),
    BACKRUN_VALIDATION_SWEEP: path.join(dir, "sweep.json"), BACKRUN_VALIDATION_BATCH: path.join(dir, "batch.json"),
    PAPER_ENV_FILE: path.join(dir, "absent.env") };
  const { main } = require("../../scripts/backrun-economic-gates");
  const summary = await main(["all"], env);
  for (const gate of ["replay", "size", "gas", "builder", "liquidity", "parity"]) assert.equal(summary[gate].passed, true, `${gate}: ${summary[gate].reason}`);
  const size = JSON.parse(fs.readFileSync(path.join(dir, "v", "size-sweep.json"), "utf8"));
  assert.equal(size.curves[0].selection.withinTolerance, true);
  assert.ok(size.manifestId && size.manifest.executorVersion === 4);
  await assert.rejects(main(["nope"], env), /Gate must be/);
});
