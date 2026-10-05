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

function discoveryFixture(start = 100, end = 103) {
  const blocks = new Map(), receipts = new Map(), logs = [];
  for (let number = start; number <= end; number++) {
    const blockHash = hash(number + 1000), tx = hash(number + 2000);
    const blockLogs = [1, 2].map((pool, index) => ({ address: addr(pool), topics: [[...SWAP_TOPICS][0]], data: "0x",
      blockNumber: utils.hexValue(number), blockHash, transactionIndex: "0x0", transactionHash: tx,
      logIndex: utils.hexValue(index), removed: false }));
    blocks.set(number, { number: utils.hexValue(number), hash: blockHash, parentHash: hash(number + 999), transactions: [tx] });
    receipts.set(tx, { transactionHash: tx, blockHash, blockNumber: utils.hexValue(number), transactionIndex: "0x0",
      status: "0x1", logs: blockLogs });
    logs.push(...blockLogs.map(log => ({ ...log, blockNumber: number, transactionIndex: 0, logIndex: Number(log.logIndex) })));
  }
  const reads = [];
  return { blocks, receipts, logs, reads, send: async (method, params) => {
    reads.push({ method, params });
    if (method === "eth_getBlockByNumber") return blocks.get(Number(params[0]));
    if (method === "eth_getTransactionReceipt") return receipts.get(params[0]);
    throw new Error("Unexpected discovery RPC method");
  } };
}
test("log discovery splits rejected ranges and retains every pool and trigger without receipt fallback", async () => {
  const { discoverTriggers } = require("../../server/backrun/localHistoricalBatch");
  const fixture = discoveryFixture(), queries = [], reports = [], events = [];
  const archive = { send: fixture.send, getLogs: async filter => {
    queries.push(filter);
    if (filter.toBlock - filter.fromBlock + 1 > 2) throw Object.assign(new Error("bad response"), { status: 400 });
    return fixture.logs.filter(log => log.address === filter.address && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock);
  } };
  const triggers = await discoverTriggers(archive, pools, { start: 100, end: 103 },
    { onDiscovery: report => reports.push(report), progress: event => events.push(event) });
  assert.equal(triggers.length, 4); assert.ok(triggers.every(trigger => trigger.affectedPools.length === 2));
  assert.equal(queries.length, 6); assert.equal(fixture.reads.length, 0);
  assert.equal(reports.at(-1).method, "eth_getLogs"); assert.equal(reports.at(-1).rangeSplits, 2);
  assert.equal(reports.at(-1).complete, true); assert.equal(events.filter(event => event.stage === "batch_discovery_split").length, 2);
});

test("single-block HTTP 400 falls back to every canonical receipt and discards partial log results", async () => {
  const { discoverTriggers } = require("../../server/backrun/localHistoricalBatch");
  const fixture = discoveryFixture(), reports = [], events = [];
  const archive = { send: fixture.send, getLogs: async filter => {
    if (filter.address === addr(1)) return fixture.logs.filter(log => log.address === addr(1));
    throw Object.assign(new Error("bad response"), { status: 400, code: "SERVER_ERROR", body: "DO_NOT_PRINT_PROVIDER_BODY" });
  } };
  const triggers = await discoverTriggers(archive, pools, { start: 100, end: 103 },
    { onDiscovery: report => reports.push(report), progress: event => events.push(event) });
  assert.equal(triggers.length, 4); assert.deepEqual(triggers.map(trigger => trigger.blockNumber), [100, 101, 102, 103]);
  assert.ok(triggers.every(trigger => trigger.affectedPools.length === 2));
  assert.equal(fixture.reads.filter(read => read.method === "eth_getTransactionReceipt").length, 4);
  const report = reports.at(-1);
  assert.equal(report.method, "canonical_receipts"); assert.equal(report.complete, true);
  assert.equal(report.blocksScanned, 4); assert.equal(report.receiptsScanned, 4);
  assert.equal(report.fallbackDiagnostic.httpStatus, 400);
  assert.ok(events.some(event => event.stage === "batch_discovery_receipt_fallback"));
  assert.ok(!JSON.stringify(events).includes("DO_NOT_PRINT_PROVIDER_BODY"));
});

test("receipt discovery fails closed on missing data, inconsistent block chains and mismatched log identities", async () => {
  const { discoverTriggers } = require("../../server/backrun/localHistoricalBatch");
  for (const mutate of [fixture => fixture.receipts.delete(hash(2101)),
    fixture => { fixture.blocks.get(101).parentHash = hash(99); },
    fixture => { fixture.receipts.get(hash(2100)).transactionIndex = null; },
    fixture => { fixture.receipts.get(hash(2100)).logs[0].transactionHash = hash(99); },
    fixture => { fixture.receipts.get(hash(2100)).status = "0x0"; }]) {
    const fixture = discoveryFixture(), reports = []; mutate(fixture);
    const archive = { send: fixture.send, getLogs: async () => { throw Object.assign(new Error("unsupported filter"), { error: { code: -32602 } }); } };
    await assert.rejects(discoverTriggers(archive, pools, { start: 100, end: 103 }, { onDiscovery: report => reports.push(report) }), /Canonical discovery/);
    assert.equal(reports.at(-1).complete, false); assert.equal(reports.at(-1).method, "canonical_receipts");
  }
});

test("authentication, quota and transient log failures never expand into receipt scans", async () => {
  const { discoverTriggers } = require("../../server/backrun/localHistoricalBatch");
  for (const status of [401, 402, 403, 429, 500, 503]) {
    let calls = 0;
    const error = Object.assign(new Error("request failed"), { status });
    const archive = { send: async () => { assert.fail("Receipt fallback must not run"); },
      getLogs: async () => { calls++; throw error; } };
    await assert.rejects(discoverTriggers(archive, pools, { start: 100, end: 103 }), candidate => candidate === error);
    assert.equal(calls, 1);
  }
});

test("malformed successful log responses remain validation failures instead of triggering fallback", async () => {
  const { discoverTriggers } = require("../../server/backrun/localHistoricalBatch");
  let reads = 0;
  const archive = { getLogs: async () => [{ ...log(0), blockNumber: 999 }], send: async () => { reads++; } };
  await assert.rejects(discoverTriggers(archive, pools, { start: 100, end: 103 }), /Invalid historical Swap log/);
  assert.equal(reads, 0);
});

test("real ethers HTTP 400 transport falls back to bounded raw receipt reads and records discovery evidence", async () => {
  const http = require("http"), { providers } = require("ethers");
  const { installArchiveReads } = require("../../scripts/backrun-archive-reads");
  const { discoverTriggers } = require("../../server/backrun/localHistoricalBatch");
  const fixture = discoveryFixture(100, 100), methods = [], reports = [];
  const server = http.createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", async () => {
      const input = JSON.parse(body); methods.push(input.method);
      if (input.method === "eth_getLogs") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "restricted log query" })); return;
      }
      const result = input.method === "eth_chainId" ? "0x1" : await fixture.send(input.method, input.params);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const archive = installArchiveReads(new providers.StaticJsonRpcProvider({ url: `http://127.0.0.1:${server.address().port}`,
      throttleLimit: 1, throttleCallback: async () => false }, 1), { minIntervalMs: 0 });
    const found = await discoverTriggers(archive, pools, { start: 100, end: 100 }, { onDiscovery: report => reports.push(report) });
    assert.equal(found.length, 1); assert.deepEqual(found[0].affectedPools, [addr(1), addr(2)]);
    assert.equal(methods.filter(method => method === "eth_getLogs").length, 1);
    assert.equal(reports.at(-1).method, "canonical_receipts"); assert.equal(reports.at(-1).complete, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
