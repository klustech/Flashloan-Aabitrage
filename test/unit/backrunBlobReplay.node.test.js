const test = require("node:test"), assert = require("node:assert/strict");
const { rawTransaction, validateCanonicalRaw } = require("../../server/backrun/rawTransaction");
const { ForkBackend } = require("../../server/backrun/forkBackend");
const { replayDiagnostic } = require("../../scripts/backrun-replay-diagnostics");
const { signedBlob } = require("../helpers/blobTransaction");

test("canonical archive blob wrappers preserve the signed body, hash and recovered sender", async () => {
  const { raw, pooled, canonical, wallet } = signedBlob();
  const fetched = await rawTransaction({ send: async () => pooled }, canonical, { canonicalReplay: true });
  assert.equal(fetched, raw);
  assert.equal(validateCanonicalRaw(fetched, canonical).from, wallet.address.toLowerCase());
  await assert.rejects(rawTransaction({ send: async () => pooled }, { ...canonical, from: "0x" + "11".repeat(20) },
    { canonicalReplay: true }), /sender mismatch/);
  await assert.rejects(rawTransaction({ send: async () => pooled }, { ...canonical, hash: "0x" + "11".repeat(32) },
    { canonicalReplay: true }), /hash mismatch/);
});

test("Hardhat fails explicitly on ordered blob replay before admitting a transaction", async () => {
  const { raw, canonical } = signedBlob(); let calls = 0;
  const backend = new ForkBackend({ url: "http://127.0.0.1:8547", provider: { send: async () => { calls++; } } });
  await assert.rejects(backend.submitRaw(raw, {}, 68, canonical), error => {
    const d = replayDiagnostic(error);
    assert.equal(d.code, "BACKRUN_BLOB_REPLAY_REQUIRES_ANVIL"); assert.equal(d.transactionIndex, 68); assert.equal(d.transactionType, 3);
    assert.equal(d.proofIssued, false); assert.ok(!JSON.stringify(d).includes(raw)); return true;
  });
  assert.equal(calls, 0);
});

test("Anvil blob admission is scoped to validated canonical bodies and cleans up on submission failure", async () => {
  const { raw, canonical } = signedBlob(), calls = [];
  const backend = new ForkBackend({ url: "http://127.0.0.1:8548", engine: "anvil", provider: { send: async (method, args) => {
    calls.push(method);
    if (method === "eth_sendRawTransaction") {
      assert.equal(args[0], raw); throw Object.assign(new Error("node rejected canonical blob"), { code: -32000 });
    }
  } } });
  backend.configureBlock = async () => {};
  await assert.rejects(backend.mine([raw], {}, { canonicalTransactions: [{ ...canonical, from: "0x" + "11".repeat(20) }] }), /sender mismatch/);
  assert.deepEqual(calls, []);
  await assert.rejects(backend.mine([raw], {}, { canonicalTransactions: [canonical] }), /node rejected/);
  assert.deepEqual(calls, ["anvil_impersonateAccount", "eth_sendRawTransaction", "anvil_stopImpersonatingAccount"]);
  assert.equal(backend.blobReplayAccounts.size, 0);
  calls.length = 0;
  await assert.rejects(backend.mine([raw], {}), /node rejected/);
  assert.deepEqual(calls, ["eth_sendRawTransaction"]);
});

test("fork identity checks enforce the selected engine and chain without relaxing loopback isolation", async () => {
  for (const [client, chain, succeeds] of [["anvil/v1.8.4", "0x1", true], ["HardhatNetwork/2.24.3", "0x1", false],
    ["anvil/v1.8.4", "0x5", false], ["Geth/v1.16", "0x1", false]]) {
    const backend = new ForkBackend({ url: "http://127.0.0.1:8548", engine: "anvil",
      provider: { send: async method => method === "eth_chainId" ? chain : client } });
    if (succeeds) assert.deepEqual(await backend.verify(), { clientVersion: client, chainId: 1 });
    else await assert.rejects(backend.verify(), /Dedicated Anvil/);
  }
  const old = new ForkBackend({ url: "http://127.0.0.1:8548", engine: "anvil",
    provider: { send: async method => method === "eth_chainId" ? "0x1" : "anvil/v1.7.1" } });
  await assert.rejects(old.verify(), /1.8.4 or newer/);
  assert.throws(() => new ForkBackend({ url: "https://mainnet.invalid", engine: "anvil" }), /loopback/);
});
