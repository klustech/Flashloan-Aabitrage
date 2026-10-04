const { Wallet, utils } = require("ethers");
// Valid blob/KZG test vector from NomicFoundation/edr (MIT).
// https://github.com/NomicFoundation/edr/blob/main/crates/edr_provider/tests/fixtures/eip4844.txt
const sidecar = {
  blob: "0x0068656c6c6f20776f726c6480".padEnd(2 + 131072 * 2, "0"),
  kzg_commitment: "0xb93ab7583ad8a57b2edd262889391f37a83ab41107dc02c1a68220841379ae828343e84ac1c70fb7c2640ee3522c4c36",
  kzg_proof: "0x86ffb073648261475af77cc902c5189bf3d33d0f63e025f23c69ac1e4cc0a7646e1a59ff8e5600f0fcc35f78fe1a4df2",
};
const versionedHash = "0x01ae39c06daecb6a178655e3fab2e56bd61e81392027947529e4def3280c546e";
function signedBlob({ wallet = Wallet.createRandom(), to = Wallet.createRandom().address, nonce = 0, data = "0x",
  maxFeePerGas = 2000000000, maxPriorityFeePerGas = 1, gasLimit = 100000 } = {}) {
  const q = value => {
    const h = require("ethers").BigNumber.from(value).toHexString().slice(2).replace(/^0+/, "");
    return h ? "0x" + (h.length % 2 ? "0" : "") + h : "0x";
  };
  const fields = [q(1), q(nonce), q(maxPriorityFeePerGas), q(maxFeePerGas), q(gasLimit),
    to, q(0), data, [], q(1000000000), [versionedHash]];
  const digest = utils.keccak256(utils.hexConcat(["0x03", utils.RLP.encode(fields)]));
  const sig = wallet._signingKey().signDigest(digest);
  fields.push(q(sig.recoveryParam), q(sig.r), q(sig.s));
  const raw = utils.hexConcat(["0x03", utils.RLP.encode(fields)]);
  const pooled = utils.hexConcat(["0x03", utils.RLP.encode([fields,
    [sidecar.blob], [sidecar.kzg_commitment], [sidecar.kzg_proof]])]);
  return { raw, pooled, wallet, canonical: { hash: utils.keccak256(raw), from: wallet.address, type: 3 } };
}
module.exports = { signedBlob, sidecar, versionedHash };

