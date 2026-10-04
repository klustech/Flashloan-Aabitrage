const test = require("node:test"), assert = require("node:assert/strict");
const http = require("http");
const { providers } = require("ethers");
const { installArchiveReads, retryableRead } = require("../../scripts/backrun-archive-reads");
const { replayDiagnostic } = require("../../scripts/backrun-replay-diagnostics");

test("archive receipt reads recover from transient HTTP failure without changing request parameters", async () => {
  const events = [], params = ["canonical-hash"], waits = [];
  let calls = 0;
  const provider = installArchiveReads({ send: async (method, received) => {
    assert.equal(method, "eth_getTransactionReceipt"); assert.equal(received, params);
    if (++calls === 1) throw Object.assign(new Error("bad response"), { code: "SERVER_ERROR", status: 503 });
    return { transactionHash: params[0], status: "0x1" };
  } }, { minIntervalMs: 0, wait: async ms => waits.push(ms), onRetry: event => events.push(event) });
  assert.equal((await provider.send("eth_getTransactionReceipt", params)).transactionHash, params[0]);
  assert.equal(calls, 2); assert.deepEqual(waits, [1000]); assert.equal(events[0].httpStatus, 503);
});

test("archive retries are bounded and expose HTTP status and method without provider bodies", async () => {
  let calls = 0;
  const provider = installArchiveReads({ send: async () => {
    calls++; throw Object.assign(new Error("bad response"), { code: "SERVER_ERROR", status: 429, body: "PRIVATE_BODY" });
  } }, { minIntervalMs: 0, wait: async () => {} });
  await assert.rejects(provider.send("eth_getTransactionReceipt", ["hash"]), error => {
    const d = replayDiagnostic(error, { stage: "canonical_receipt", transactionIndex: 41 });
    assert.equal(d.httpStatus, 429); assert.equal(d.attempts, 3); assert.equal(d.rpcMethod, "eth_getTransactionReceipt");
    assert.equal(d.stage, "canonical_receipt"); assert.equal(d.retryable, true);
    assert.ok(!JSON.stringify(d).includes("PRIVATE_BODY")); return true;
  });
  assert.equal(calls, 3);
});

test("authentication, exhausted quota, execution and canonical validation errors are not retried", async () => {
  for (const error of [Object.assign(new Error("unauthorized"), { status: 401 }),
    Object.assign(new Error("forbidden"), { status: 403 }), Object.assign(new Error("quota"), { status: 402 }),
    Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" }), new Error("Canonical transaction sender mismatch")]) {
    let calls = 0;
    const provider = installArchiveReads({ send: async () => { calls++; throw error; } }, { minIntervalMs: 0, wait: async () => {} });
    await assert.rejects(provider.send("eth_call", []), candidate => candidate === error);
    assert.equal(calls, 1);
  }
  assert.equal(retryableRead({ code: "SERVER_ERROR", serverError: { code: "ECONNRESET" } }), true);
  assert.equal(retryableRead({ error: { code: -32005 } }), true);
});

test("archive read retry policy never repeats transaction submissions or fork mutations", async () => {
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "hardhat_reset", "evm_mine"]) {
    let calls = 0;
    const provider = installArchiveReads({ send: async () => { calls++; throw Object.assign(new Error("bad response"), { status: 503 }); } },
      { minIntervalMs: 0, wait: async () => {} });
    await assert.rejects(provider.send(method, [])); assert.equal(calls, 1);
  }
});

test("archive request pacing spaces concurrent reads and preserves zero-interval configuration", async () => {
  let now = 0; const starts = [];
  const provider = installArchiveReads({ send: async () => { starts.push(now); return true; } },
    { minIntervalMs: 150, clock: () => now, wait: async ms => { await new Promise(resolve => setImmediate(resolve)); now += ms; } });
  await Promise.all([provider.send("eth_getCode", []), provider.send("eth_getBalance", []), provider.send("eth_call", [])]);
  assert.deepEqual(starts, [0, 150, 300]);
  assert.throws(() => installArchiveReads({ send() {} }, { maxAttempts: 10 }), /supported range/);
});

test("real ethers HTTP transport exposes and retries a 503 receipt response", async () => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body); calls++;
      response.writeHead(calls === 1 ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(calls === 1 ? { error: "temporarily unavailable" } : { jsonrpc: "2.0", id: input.id,
        result: { transactionHash: input.params[0], status: "0x1" } }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = installArchiveReads(new providers.StaticJsonRpcProvider({
      url: `http://127.0.0.1:${server.address().port}`, throttleLimit: 1, throttleCallback: async () => false,
    }, 1), { minIntervalMs: 0, baseDelayMs: 0 });
    const result = await provider.send("eth_getTransactionReceipt", ["canonical-hash"]);
    assert.equal(result.transactionHash, "canonical-hash"); assert.equal(calls, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
