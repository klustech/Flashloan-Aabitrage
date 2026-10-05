const test = require("node:test"), assert = require("node:assert/strict");
const { utils } = require("ethers");
const { bn } = require("../../server/bot/units");
const { batchOptions, poolReferences, groupSwapLogs, verifyTrigger, blockFeeReference,
  candidateRoutes, sizeCandidates, summarizeBatch } = require("../../server/backrun/localHistoricalBatch");
const { runBatch } = require("../../scripts/backrun-executor-batch");
const { SWAP_TOPICS } = require("../../server/backrun/triggerDecoder");
const addr = number => "0x" + number.toString(16).padStart(40, "0"), hash = number => "0x" + number.toString(16).padStart(64, "0");
const profile = { routers: { uniswap_v2: { router: addr(1) }, sushiswap_v2: { router: addr(2) } },
  backrun: { maxAmountBySymbol: { WETH: "1" } } };
const fixture = { targetBlock: 100 }, pools = [{ poolAddress: addr(1) }, { poolAddress: addr(2) }];
const options = batchOptions(profile, fixture, {});
const log = (index, pool = 1) => ({ address: addr(pool), topics: [[...SWAP_TOPICS][0]], blockNumber: 100,
  transactionIndex: index, transactionHash: hash(index + 10), blockHash: hash(1000), removed: false });

test("batch bounds validate ranges, sizes, search budgets and supported pool identities", () => {
  assert.equal(options.start, 91); assert.equal(options.end, 110);
  assert.equal(options.maximum.toString(), utils.parseEther("1").toString());
  for (const env of [{ BACKRUN_START_BLOCK: "100" }, { BACKRUN_END_BLOCK: "101" },
    { BACKRUN_START_BLOCK: "100", BACKRUN_END_BLOCK: "200" }, { BACKRUN_BATCH_MAX_TRIGGERS: "0" },
    { BACKRUN_BATCH_SIZING_SAMPLES: "Infinity" }, { BACKRUN_BATCH_FINALISTS: "6" },
    { BACKRUN_BATCH_MIN_AMOUNT_WETH: "2" }, { BACKRUN_BATCH_MIN_AMOUNT_WETH: "-1" }])
    assert.throws(() => batchOptions(profile, fixture, env));
  assert.equal(poolReferences(profile, [{ dex: "uniswap_v2", address: addr(1) }, { dex: "sushiswap_v2", address: addr(2) }]).length, 2);
  assert.throws(() => poolReferences(profile, [{ dex: "uniswap_v2", address: addr(1) }, { dex: "sushiswap_v2", address: addr(1) }]), /Duplicate/);
  assert.throws(() => poolReferences(profile, [{ dex: "unsupported", address: addr(1) }, { dex: "sushiswap_v2", address: addr(2) }]));
});

test("Swap discovery groups multiple logs per transaction without counting alternatives as independent triggers", () => {
  const grouped = groupSwapLogs([log(3), log(1), log(3, 2), log(3)], pools, 91, 110);
  assert.deepEqual(grouped.map(row => row.transactionIndex), [1, 3]);
  assert.deepEqual(grouped[1].affectedPools, [addr(1), addr(2)]);
  for (const bad of [{ ...log(1), removed: true }, { ...log(1), address: addr(9) },
    { ...log(1), blockNumber: 111 }, { ...log(1), topics: [hash(0)] }])
    assert.throws(() => groupSwapLogs([bad], pools, 91, 110));
  assert.throws(() => groupSwapLogs([log(1), { ...log(1), transactionHash: hash(99) }], pools, 91, 110), /Conflicting/);
});

test("discovery must match successful canonical Swap receipts and block identity", () => {
  const trigger = groupSwapLogs([log(0)], pools, 91, 110)[0];
  const receipt = { transactionHash: trigger.triggerHash, blockHash: trigger.blockHash, transactionIndex: 0, status: 1, logs: [log(0)] };
  const data = { block: { hash: trigger.blockHash, transactions: [{ hash: trigger.triggerHash }] }, receipts: [receipt] };
  verifyTrigger(data, trigger);
  assert.throws(() => verifyTrigger({ ...data, receipts: [{ ...receipt, status: 0 }] }, trigger));
  assert.throws(() => verifyTrigger({ ...data, receipts: [{ ...receipt, logs: [] }] }, trigger));
  assert.throws(() => verifyTrigger({ ...data, block: { ...data.block, hash: hash(99) } }, trigger));
});

test("block fee reference uses actual base fee and median successful priority, without claiming builder inclusion", () => {
  const data = { block: { baseFeePerGas: bn(100) }, receipts: [
    { status: 1, effectiveGasPrice: bn(140) }, { status: 0, effectiveGasPrice: bn(999999) },
    { status: 1, effectiveGasPrice: bn(110) }, { status: 1, effectiveGasPrice: bn(120) }] };
  const reference = blockFeeReference(data);
  assert.equal(reference.priorityFeePerGas, "20"); assert.equal(reference.effectiveGasPrice, "120");
  assert.equal(reference.sampleCount, 3); assert.equal(reference.winningBuilderBidKnown, false);
  assert.equal(reference.usesFutureBlockInformation, true);
  assert.throws(() => blockFeeReference({ ...data, receipts: [{ status: 1, effectiveGasPrice: bn(99) }] }));
});

test("routes include both WETH directions, retain pool identity and require actual affected-pool contact", () => {
  const weth = addr(7), other = addr(8), leg = (pool, input, output) => ({ chainId: 1, dex: "uniswap_v2",
    poolAddress: addr(pool), tokenIn: input, tokenOut: output, feeTier: 0 });
  const registry = { edges: () => [leg(1, weth, other), leg(1, other, weth), leg(2, weth, other), leg(2, other, weth)] };
  const routes = candidateRoutes(registry, weth, [addr(1)], 100);
  assert.equal(routes.length, 2); assert.notEqual(routes[0].id, routes[1].id);
  assert.equal(candidateRoutes(registry, weth, [addr(9)], 100).length, 0);
});

test("exact sizing refines a concave opportunity, respects lender liquidity, and records quote errors", async () => {
  const route = { id: "controlled", legs: [] }, quoted = [];
  const quoter = { quoteRoute: async (route, amount) => {
    quoted.push(amount.toNumber());
    if (amount.eq(1)) throw new Error("controlled transport failure");
    return { route, borrowAmount: amount, expectedFinalAmount: amount.add(amount.mul(10)).sub(amount.mul(amount).div(10)) };
  } };
  const sized = await sizeCandidates({ routes: [route], quoter, block: { number: 100 },
    terms: { premiumBps: 1000, availableLiquidity: bn(40) }, flashloan: { fee: (amount, bps) => amount.mul(bps).div(10000) },
    options: { minimum: bn(1), maximum: bn(100), samples: 5, refinements: 5, finalists: 2 } });
  assert.equal(sized.candidates.length, 4);
  const capital = sized.candidates.filter(row => row.fundingMode === "CAPITAL");
  assert.ok(capital[0].quote.borrowAmount.gte(45) && capital[0].quote.borrowAmount.lte(55));
  assert.ok(sized.candidates.filter(row => row.fundingMode === "FLASH_LOAN").every(row => row.quote.borrowAmount.lte(40)));
  assert.ok(sized.errors.length > 0); assert.equal(sized.quoteProbes, quoted.length);
});
const measured = (mode, net, amount = "0.1") => ({ fundingMode: mode, status: "MEASURED", amountWeth: amount,
  executionSucceeded: true, canonicalReceiptsVerified: true, sameBlock: true, principalPreserved: true,
  netAfterGasNative: String(net), netPositive: net > 0, meetsConfiguredMinimum: net >= 10, triggerCreatedGrossEdge: true });
const result = (number, executions = []) => ({ blockNumber: number, triggerHash: hash(number),
  transactionIndex: 0, status: "EVALUATED", errors: [], executions });

test("batch summary counts each trigger once per mode, excludes technical failures and does not sum mutually exclusive profits", () => {
  const rows = [result(100, [measured("CAPITAL", 5), measured("CAPITAL", 20), measured("FLASH_LOAN", -3)]),
    result(101, [measured("CAPITAL", 30)]), { ...result(102, [measured("CAPITAL", 999999)]), errors: [{ reason: "failure" }] }];
  const summary = summarizeBatch(rows, { discoveredTriggers: 3, finished: true });
  assert.equal(summary.byMode.CAPITAL.netPositiveTriggers, 2);
  assert.equal(summary.byMode.CAPITAL.bestMeasured.netAfterGasNative, "30");
  assert.equal(summary.byMode.FLASH_LOAN.netPositiveTriggers, 0);
  assert.equal(summary.evaluatedTriggers, 2); assert.equal(summary.complete, false);
  assert.equal(summary.profitsMustNotBeSummed, true); assert.equal(summary.netTotal, undefined);
  assert.throws(() => summarizeBatch([rows[0], rows[0]], { discoveredTriggers: 2 }), /Duplicate/);
});
function harness({ triggers = [log(0), log(1)], limit = 200, fail = false, replayFails = false } = {}) {
  const checkpoints = [], calls = [], loads = [];
  const grouped = groupSwapLogs(triggers, pools, 91, 110);
  return { checkpoints, calls, loads, args: { profile, archive: {}, backend: { exclusive: async work => work() },
    pools: [{ dex: "uniswap_v2", poolAddress: addr(1) }, { dex: "sushiswap_v2", poolAddress: addr(2) }],
    options: { ...options, maxTriggers: limit }, topologySource: "test", artifact: {},
    write: (_path, report) => checkpoints.push(JSON.parse(JSON.stringify(report))), discover: async () => grouped,
    replay: { block: async number => { loads.push(number); if (replayFails) throw new Error("archive unavailable"); return { block: { number } }; } },
    evaluate: async ({ trigger }) => {
      calls.push(trigger);
      if (fail) { const error = new Error("uncertain mining outcome"); error.batchResult = { ...trigger, status: "ERROR", errors: [{}], executions: [] }; throw error; }
      return { ...result(trigger.blockNumber), ...trigger };
    } } };
}
test("batch checkpoints complete coverage, caches one canonical block and marks trigger truncation incomplete", async () => {
  const h = harness(), report = await runBatch(h.args);
  assert.equal(report.complete, true); assert.equal(report.discoveredTriggers, 2);
  assert.equal(report.evaluatedTriggers, 2); assert.deepEqual(h.loads, [100]);
  assert.equal(h.checkpoints[0].complete, false); assert.equal(h.checkpoints.at(-1).status, "finished");
  const limited = harness({ limit: 1 }), partial = await runBatch(limited.args);
  assert.equal(partial.complete, false); assert.equal(partial.truncated, true); assert.equal(limited.calls.length, 1);
});
test("canonical failures and unknown mining outcome never issue a complete batch or continue mining", async () => {
  const failed = harness({ replayFails: true }), report = await runBatch(failed.args);
  assert.equal(report.complete, false); assert.ok(report.technicalErrors > 0); assert.equal(failed.calls.length, 0);
  const uncertain = harness({ fail: true }); await assert.rejects(runBatch(uncertain.args), /uncertain/);
  assert.equal(uncertain.calls.length, 1); assert.equal(uncertain.checkpoints.at(-1).status, "failed");
  assert.equal(uncertain.checkpoints.at(-1).complete, false);
});
test("historical batch refuses an execution key before fork startup and redacts credentials", () => {
  const { spawnSync } = require("child_process"), path = require("path");
  const secret = "batch-test-private-key";
  const run = spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/backrun-executor-batch.js")], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, PRIVATE_KEY: secret,
      PAPER_ENV_FILE: "nonexistent-batch-test.env", MAINNET_RPC_URL: "https://not-contacted.invalid/secret-url" } });
  assert.equal(run.status, 1); assert.equal(run.stdout, ""); assert.match(JSON.parse(run.stderr).message, /refuse PRIVATE_KEY/);
  assert.ok(!run.stderr.includes(secret)); assert.ok(!run.stderr.includes("secret-url"));
});

test("zero discovered triggers completes only an empty coverage result and never invents positive trades", async () => {
  const empty = harness({ triggers: [] }), report = await runBatch(empty.args);
  assert.equal(report.complete, true); assert.equal(report.discoveredTriggers, 0);
  assert.equal(report.byMode.CAPITAL.netPositiveTriggers, 0); assert.equal(report.byMode.FLASH_LOAN.bestMeasured, null);
  assert.equal(report.commissioningEvidence, false); assert.equal(report.builderInclusionTested, false);
  assert.equal(empty.calls.length, 0); assert.equal(empty.loads.length, 0);
});

test("Swap log archive reads use bounded transport retries and preserve exact discovery filters", async () => {
  const { installArchiveReads } = require("../../scripts/backrun-archive-reads");
  const calls = [], filters = [{ address: addr(1), fromBlock: "0x5b", toBlock: "0x6e", topics: [[...SWAP_TOPICS]] }];
  const provider = installArchiveReads({ send: async (method, params) => {
    calls.push({ method, params });
    if (calls.length === 1) { const error = new Error("temporarily unavailable"); error.status = 503; throw error; }
    return [log(1)];
  } }, { minIntervalMs: 0, baseDelayMs: 0, wait: async () => {} });
  assert.deepEqual(await provider.send("eth_getLogs", filters), [log(1)]);
  assert.equal(calls.length, 2); assert.equal(calls.every(call => call.method === "eth_getLogs" && call.params === filters), true);
});
