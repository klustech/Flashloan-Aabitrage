const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http");
const { providers } = require("ethers");
const { ForkBackend } = require("../../server/backrun/forkBackend");
const { replayDiagnostic } = require("../../scripts/backrun-replay-diagnostics");

async function rpcServer(work, { delay = 100, status = 200 } = {}) {
  const requests = [], timers = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body); requests.push(request.method);
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1" }));
      }, delay);
      timers.add(timer);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`, requests); }
  finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test("historical mining has its own HTTP budget; ordinary RPC retains its shorter deadline", async () => {
  await rpcServer(async (url, requests) => {
    const provider = new providers.StaticJsonRpcProvider({ url, timeout: 20, throttleLimit: 1 }, 1);
    const progress = [];
    const backend = new ForkBackend({ url, provider, miningTimeoutMs: 1000,
      miningProgress: event => progress.push(event) });
    await backend.mineBlock({ number: 26115902 }, 143);
    await assert.rejects(backend.provider.send("eth_chainId", []), { code: "TIMEOUT" });
    assert.deepEqual(requests, ["evm_mine", "eth_chainId"]);
    assert.deepEqual(progress.map(event => event.stage), ["mining_started", "mining_complete"]);
    assert.equal(progress[0].transactionCount, 143);
    assert.equal(progress[0].timeoutMs, 1000);
    assert.equal(backend.miningOutcomeUnknown, false);
  });
});

test("expired mining is never resubmitted and blocks later fork mutations", async () => {
  await rpcServer(async (url, requests) => {
    const backend = new ForkBackend({ url, miningTimeoutMs: 1000 });
    await assert.rejects(backend.mineBlock({ number: 26115902 }, 143), error => {
      const diagnostic = replayDiagnostic(error, { stage: "mine_prefix", endIndex: 142 });
      assert.equal(diagnostic.code, "TIMEOUT");
      assert.equal(diagnostic.rpcMethod, "evm_mine");
      assert.deepEqual(diagnostic.parameterTypes, []);
      assert.equal(diagnostic.timeoutMs, 1000);
      assert.equal(diagnostic.miningOutcomeUnknown, true);
      assert.ok(diagnostic.elapsedMs >= 900);
      return true;
    });
    backend.blobReplayAccounts.add("0x0000000000000000000000000000000000000001");
    await backend.clearBlobReplayAccounts();
    await assert.rejects(backend.reset({}), { code: "BACKRUN_FORK_RESTART_REQUIRED" });
    await assert.rejects(backend.configureBlock({}), { code: "BACKRUN_FORK_RESTART_REQUIRED" });
    await assert.rejects(backend.submitRaw("0x", {}, 0), { code: "BACKRUN_FORK_RESTART_REQUIRED" });
    await assert.rejects(backend.mineBlock({}, 0), { code: "BACKRUN_FORK_RESTART_REQUIRED" });
    assert.equal(backend.blobReplayAccounts.size, 1);
    assert.deepEqual(requests, ["evm_mine"]);
  }, { delay: 1500 });
});

test("HTTP rate limiting cannot transparently repeat a mining mutation", async () => {
  await rpcServer(async (url, requests) => {
    const backend = new ForkBackend({ url, miningTimeoutMs: 1000 });
    await assert.rejects(backend.mineBlock({}, 0));
    assert.deepEqual(requests, ["evm_mine"]);
    assert.equal(backend.miningOutcomeUnknown, true);
  }, { delay: 0, status: 429 });
});

test("production default budget remains 30 seconds and invalid historical budgets fail", () => {
  const url = "http://127.0.0.1:8547";
  const backend = new ForkBackend({ url, provider: { send: async () => true } });
  assert.equal(backend.miningTimeoutMs, 30000);
  assert.equal(backend.miningProvider, backend.provider);
  for (const miningTimeoutMs of [0, 999, 1800001, "bad", 1000.5])
    assert.throws(() => new ForkBackend({ url, miningTimeoutMs }), /mining timeout/);
});
