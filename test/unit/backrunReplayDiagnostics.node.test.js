const test = require("node:test");
const assert = require("node:assert/strict");
const { redact, replayDiagnostic } = require("../../scripts/backrun-replay-diagnostics");
const { HistoricalReplay } = require("../../server/backrun/historicalReplay");

test("replay diagnostics expose the failing stage and redact provider credentials and signed payloads", () => {
  const env = { MAINNET_RPC_URL: "https://rpc.example/v2/my-secret-token", PRIVATE_KEY: "0x" + "a".repeat(64), API_KEY: "another-secret" };
  const error = Object.assign(new Error(`${env.MAINNET_RPC_URL} ${env.PRIVATE_KEY} ${env.API_KEY}`), {
    code: "SERVER_ERROR", error: { message: "unauthorized https://other.example/v2/unknown-secret 0x" + "b".repeat(300) },
    body: "DO_NOT_PRINT", requestBody: "DO_NOT_PRINT",
  });
  const result = replayDiagnostic(error, { stage: "signed_transaction", blockNumber: 26115902, transactionIndex: 42, transactionType: 4 }, env);
  assert.equal(result.stage, "signed_transaction");
  assert.equal(result.transactionIndex, 42);
  assert.equal(result.code, "SERVER_ERROR");
  assert.equal(result.proofIssued, false);
  const output = JSON.stringify(result);
  for (const secret of [...Object.values(env), "unknown-secret", "DO_NOT_PRINT", "b".repeat(64)]) assert.ok(!output.includes(secret));
  assert.ok(result.rpcMessage.includes("unauthorized"));
  assert.ok(!redact(encodeURIComponent(env.MAINNET_RPC_URL), env).includes("secret-token"));
  assert.equal(redact('processing response error (body="DO_NOT_PRINT", requestBody="DO_NOT_PRINT")'), "processing response error");
  const connection = replayDiagnostic({ reason: "missing response", error: { reason: "missing response", error: { code: "ECONNREFUSED", message: "connect refused" } } });
  assert.equal(connection.causes.at(-1).code, "ECONNREFUSED");
});

test("canonical replay reports the exact signed-envelope index before a reconstruction failure", async () => {
  const stages = [], hash = "0x" + "1".repeat(64), parent = "0x" + "2".repeat(64);
  const archive = {
    getBlockWithTransactions: async () => ({ number: 10, hash, parentHash: parent, transactions: [{ hash, type: 99 }] }),
    send: async method => method === "eth_getBlockByNumber" ? { hash } : null,
    getBlock: async () => ({ number: 9, hash: parent }),
  };
  const replay = new HistoricalReplay({ archive, backend: {}, progress: event => stages.push(event) });
  await assert.rejects(replay.block(10), /unsupported/);
  assert.deepEqual(stages.at(-1), { stage: "signed_transaction", blockNumber: 10, transactionIndex: 0, transactionType: 99 });
});
