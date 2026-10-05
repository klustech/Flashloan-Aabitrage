const test = require("node:test"), assert = require("node:assert/strict");
const { utils } = require("ethers");
const { sweepOptions, summarizeSweep } = require("../../server/backrun/localSweep");
const profile = cap => ({ backrun: { maxAmountBySymbol: { WETH: cap } } });
const historical = utils.parseEther("0.06080858030334331");

test("default sweep includes historical size, respects WETH cap and preserves the historical fee comparator", () => {
  const options = sweepOptions(profile("1"), historical, {});
  assert.equal(options.amounts.length, 8); assert.ok(options.amounts.some(amount => amount.eq(historical)));
  assert.deepEqual(options.priorities, [0, 2500, 5000, 10000]);
  const small = sweepOptions(profile("0.05"), historical, {});
  assert.deepEqual(small.amounts.map(utils.formatEther), ["0.01", "0.03"]);
});

test("custom sweep rejects excessive sizes, malformed amounts, unbounded grids and missing historical fee", () => {
  for (const amounts of ["0", "-1", "1e3", "0.0000000000000000001", "2", "0.01,"].map(value => ({ BACKRUN_SWEEP_AMOUNTS_WETH: value })))
    assert.throws(() => sweepOptions(profile("1"), historical, amounts));
  assert.throws(() => sweepOptions(profile("1"), historical, { BACKRUN_SWEEP_AMOUNTS_WETH: Array(13).fill("0.01").join(",") }));
  for (const priority of ["0,5000", "-1,10000", "20001,10000", "0,1,2,3,10000", "NaN,10000"])
    assert.throws(() => sweepOptions(profile("1"), historical, { BACKRUN_SWEEP_PRIORITY_BPS: priority }));
  const result = sweepOptions(profile("1"), historical, { BACKRUN_SWEEP_AMOUNTS_WETH: "0.1,0.01,0.1", BACKRUN_SWEEP_PRIORITY_BPS: "10000,0,10000" });
  assert.deepEqual(result.amounts.map(utils.formatEther), ["0.01", "0.1"]); assert.deepEqual(result.priorities, [0, 10000]);
});

test("summary separates hypothetical cheaper bids from historical-fee results and never adds exclusive profits", () => {
  const row = (fundingMode, amountWeth, priorityFeeBps, net) => ({ fundingMode, amountWeth, priorityFeeBps, status: "MEASURED",
    executionSucceeded: true, canonicalReceiptsVerified: true, sameBlock: true, netAfterGasNative: String(net), netPositive: net > 0 });
  const summary = summarizeSweep([row("CAPITAL", "0.06", 10000, -2), row("CAPITAL", "0.03", 10000, -4),
    row("CAPITAL", "0.06", 0, 50), row("FLASH_LOAN", "0.1", 10000, 3),
    { status: "QUOTE_REJECTED" }, { status: "ERROR", netAfterGasNative: "999999", fundingMode: "CAPITAL" }]);
  assert.equal(summary.bestAtHistoricalFee.CAPITAL.netAfterGasNative, "-2");
  assert.equal(summary.bestAcrossTestedFees.CAPITAL.netAfterGasNative, "50");
  assert.equal(summary.profitableAtHistoricalFee, 1); assert.equal(summary.technicalErrors, 1);
  assert.equal(summary.profitsMustNotBeSummed, true); assert.equal(summary.lowerBidsDoNotProveInclusion, true);
  assert.equal(summary.netTotal, undefined);
});

test("sweep refuses an execution key before starting the local node or contacting archive RPC", () => {
  const { spawnSync } = require("child_process"), path = require("path");
  const secret = "test-execution-key-not-used";
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/backrun-executor-sweep.js")], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, PRIVATE_KEY: secret,
      PAPER_ENV_FILE: "nonexistent-sweep-test.env", MAINNET_RPC_URL: "https://not-contacted.invalid/private-path" },
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(JSON.parse(result.stderr).message, /refuse PRIVATE_KEY/);
  assert.ok(!result.stderr.includes(secret)); assert.ok(!result.stderr.includes("private-path"));
});
