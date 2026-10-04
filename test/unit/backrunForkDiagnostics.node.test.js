const test = require("node:test"), assert = require("node:assert/strict");
const { Wallet, utils } = require("ethers");
const { ForkBackend } = require("../../server/backrun/forkBackend");
const { replayDiagnostic } = require("../../scripts/backrun-replay-diagnostics");

test("header schema failure identifies the RPC method without exposing parameter values", async () => {
  const randao = "0x" + "ab".repeat(32);
  const backend = new ForkBackend({ url: "http://127.0.0.1:8547", provider: { send: async method => {
    if (method === "hardhat_setPrevRandao") throw Object.assign(new Error("processing response error"),
      { code: "SERVER_ERROR", error: { code: -32602, message: "unexpected string" } });
    return true;
  } } });
  await assert.rejects(backend.configureBlock({ timestamp: 100, baseFeePerGas: 1, gasLimit: 30000000, mixHash: randao }), error => {
    const result = replayDiagnostic(error, { stage: "mine_prefix", endIndex: 142 });
    assert.equal(result.rpcMethod, "hardhat_setPrevRandao");
    assert.equal(result.rpcSurface, "local_fork");
    assert.deepEqual(result.parameterTypes, ["string"]);
    assert.ok(!JSON.stringify(result).includes(randao)); return true;
  });
});

test("raw submission failure identifies canonical transaction index/type without exposing signed bytes", async () => {
  const wallet = Wallet.createRandom(), raw = await wallet.signTransaction({ nonce: 0, chainId: 1,
    to: Wallet.createRandom().address, gasLimit: 21000, gasPrice: 1 });
  let submissions = 0;
  const backend = new ForkBackend({ url: "http://127.0.0.1:8547", provider: { send: async method => {
    if (method === "eth_sendRawTransaction") { submissions++; throw Object.assign(new Error("unexpected string"), { code: -32602 }); }
    return true;
  } } });
  backend.configureBlock = async () => {};
  await assert.rejects(backend.mine([raw], {}, { canonicalTransactions: [utils.parseTransaction(raw)] }), error => {
    const result = replayDiagnostic(error, { stage: "mine_prefix", endIndex: 142 });
    assert.equal(result.rpcMethod, "eth_sendRawTransaction"); assert.equal(result.transactionIndex, 0);
    assert.equal(result.transactionType, 0); assert.ok(!JSON.stringify(result).includes(raw)); return true;
  });
  assert.equal(submissions, 1);
});
