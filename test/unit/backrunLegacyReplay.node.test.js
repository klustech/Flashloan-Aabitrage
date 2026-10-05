const test = require("node:test"), assert = require("node:assert/strict");
const { Wallet, utils } = require("ethers");
const { rawTransaction, validateRaw, validateCanonicalRaw } = require("../../server/backrun/rawTransaction");
const { HistoricalReplay } = require("../../server/backrun/historicalReplay");
const { ForkBackend } = require("../../server/backrun/forkBackend");
const { replayDiagnostic } = require("../../scripts/backrun-replay-diagnostics");
const recipient = "0x0000000000000000000000000000000000000001";
async function signed(chainId = 0, type = 0) {
  const wallet = Wallet.createRandom();
  const tx = { to: recipient, nonce: 0, chainId, type, gasLimit: 21000, gasPrice: 1, value: 0 };
  if (type === 2) { delete tx.gasPrice; tx.maxFeePerGas = 2; tx.maxPriorityFeePerGas = 1; }
  const raw = await wallet.signTransaction(tx), parsed = utils.parseTransaction(raw);
  return { raw, parsed, wallet };
}

test("canonical replay accepts authentic unprotected legacy signatures without rewriting their chain ID or bytes", async () => {
  const { raw, parsed, wallet } = await signed();
  assert.equal(parsed.chainId, 0);
  assert.ok([27, 28].includes(parsed.v));
  assert.throws(() => validateRaw(raw, parsed.hash), /Signed mainnet/);
  const recovered = validateCanonicalRaw(raw, parsed);
  assert.equal(recovered.chainId, 0);
  assert.equal(recovered.from, wallet.address.toLowerCase());
  assert.equal(await rawTransaction({ send: async () => raw }, parsed, { canonicalReplay: true }), raw);
  assert.equal(await rawTransaction({ send: async () => null }, parsed, { canonicalReplay: true }), raw);
  await assert.rejects(rawTransaction({ send: async () => raw }, parsed), /Signed mainnet/);
});

test("canonical legacy replay preserves hash/signer checks and rejects other-chain or unsigned envelopes", async () => {
  const { raw, parsed } = await signed();
  assert.throws(() => validateCanonicalRaw(raw, { ...parsed, hash: "0x" + "1".repeat(64) }), /hash mismatch/);
  assert.throws(() => validateCanonicalRaw(raw, { ...parsed, from: recipient }), /sender mismatch/);
  assert.throws(() => validateCanonicalRaw(raw, { hash: parsed.hash }), /hash and sender/);
  assert.throws(() => validateRaw(raw, parsed.hash, 1, { allowUnprotectedLegacy: true }), /Canonical sender/);
  for (const [chain, type] of [[5, 0], [0, 1], [0, 2]]) {
    const other = await signed(chain, type);
    assert.throws(() => validateCanonicalRaw(other.raw, other.parsed), /Signed mainnet/);
  }
  const unsigned = utils.serializeTransaction({ to: recipient, nonce: 0, gasLimit: 21000, gasPrice: 1, chainId: 0 });
  assert.throws(() => validateCanonicalRaw(unsigned, { hash: utils.keccak256(unsigned), from: parsed.from }), /Signed mainnet/);
});

test("historical block reconstruction opts in only with canonical hash/sender records", async () => {
  const { raw, parsed } = await signed();
  const hash = "0x" + "2".repeat(64), parentHash = "0x" + "3".repeat(64);
  const archive = {
    getBlockWithTransactions: async () => ({ number: 10, hash, parentHash, transactions: [parsed] }),
    getBlock: async () => ({ number: 9, hash: parentHash }),
    send: async method => method === "eth_getBlockByNumber" ? { hash } : raw,
    getTransactionReceipt: async () => ({ transactionHash: parsed.hash }),
  };
  assert.equal((await new HistoricalReplay({ archive, backend: {} }).block(10)).raw[0], raw);
});

test("fork prefix rejects unprotected transactions without canonical context before submitting any raw transaction", async () => {
  const { raw, parsed } = await signed();
  let submitted = 0;
  const provider = { send: async () => { submitted++; } };
  const backend = new ForkBackend({ url: "http://127.0.0.1:8547", provider });
  backend.configureBlock = async () => {};
  await assert.rejects(backend.mine([raw], {}), /Signed mainnet/);
  await assert.rejects(backend.mine([raw], {}, { canonicalTransactions: [] }), /count mismatch/);
  await assert.rejects(backend.mine([raw], {}, { canonicalTransactions: [{ ...parsed, from: recipient }] }), /sender mismatch/);
  assert.equal(submitted, 0);
});

test("signature diagnostics expose chain ID and v without exposing the signed payload", async () => {
  const { raw, parsed } = await signed();
  try { validateRaw(raw, parsed.hash); assert.fail("strict validation accepted unprotected legacy"); }
  catch (error) {
    const diagnostic = replayDiagnostic(error, { stage: "signed_transaction", transactionIndex: 104 });
    assert.equal(diagnostic.transactionChainId, 0);
    assert.ok([27, 28].includes(diagnostic.signatureV));
    assert.ok(!JSON.stringify(diagnostic).includes(raw));
  }
});
