const { utils } = require("ethers");
const { address } = require("../bot/units");
function validateRaw(rawTx, expectedHash, chainId = 1) {
  if (!utils.isHexString(rawTx) || !utils.isHexString(expectedHash, 32) ||
      utils.keccak256(rawTx).toLowerCase() !== expectedHash.toLowerCase())
    throw new Error("Raw trigger transaction hash mismatch");
  let tx;
  const type = parseInt(rawTx.slice(2,4),16);
  if (type === 3 || type === 4) {
    const fields = utils.RLP.decode("0x"+rawTx.slice(4));
    const length = type === 3 ? 14 : 13;
    if (!Array.isArray(fields) || fields.length !== length) throw new Error("Unsupported signed envelope");
    const n = value => value === "0x" ? 0 : Number(value);
    const parity = n(fields[length-3]), r = utils.hexZeroPad(fields[length-2],32), s = utils.hexZeroPad(fields[length-1],32);
    if (![0,1].includes(parity)) throw new Error("Invalid trigger signature parity");
    const digest = utils.keccak256(utils.hexConcat([utils.hexlify(type),utils.RLP.encode(fields.slice(0,-3))]));
    tx = { chainId:n(fields[0]),nonce:n(fields[1]),from:utils.recoverAddress(digest,{r,s,v:27+parity}),
      to:fields[5],value:fields[6],data:fields[7],gasLimit:require("../bot/units").bn(fields[4]),type,r,s };
  } else tx = utils.parseTransaction(rawTx);
  if (tx.chainId !== chainId || !tx.from || !tx.r || !tx.s)
    throw new Error("Signed mainnet trigger required");
  return { ...tx, from: address(tx.from) };
}
async function rawTransaction(provider, tx) {
  if (!tx?.hash) throw new Error("Transaction unavailable");
  let raw;
  try { raw = await provider.send("eth_getRawTransactionByHash", [tx.hash]); } catch (_) {}
  if (!raw) {
    const type = Number(tx.type ?? 0);
    if (![0, 1, 2, 3, 4].includes(type) || !tx.r || !tx.s || (tx.v === undefined && tx.yParity === undefined))
      throw new Error("Signed transaction envelope unsupported/unavailable");
    const quantity = value => { const h = require("../bot/units").bn(value ?? 0).toHexString().slice(2).replace(/^0+/, ""); return h ? "0x"+(h.length%2?"0":"")+h : "0x"; };
    if (type === 3 || type === 4) {
      const full = (tx.blobVersionedHashes || tx.authorizationList) ? tx :
        await provider.send("eth_getTransactionByHash", [tx.hash]);
      const access = (full.accessList || []).map(x => Array.isArray(x)?x:[x.address,x.storageKeys]);
      const fields = [quantity(full.chainId),quantity(full.nonce),quantity(full.maxPriorityFeePerGas),
        quantity(full.maxFeePerGas),quantity(full.gasLimit??full.gas),full.to||"0x",
        quantity(full.value),full.data??full.input??"0x",access];
      if (type === 3) {
        if (!full.blobVersionedHashes) throw new Error("Blob hashes missing");
        fields.push(quantity(full.maxFeePerBlobGas),full.blobVersionedHashes);
      } else {
        if (!full.authorizationList) throw new Error("Authorization list missing");
        fields.push(full.authorizationList.map(a => [quantity(a.chainId),a.address,quantity(a.nonce),
          quantity(a.yParity),quantity(a.r),quantity(a.s)]));
      }
      fields.push(quantity(full.yParity??full.v),quantity(full.r),quantity(full.s));
      raw = utils.hexConcat([utils.hexlify(type),utils.RLP.encode(fields)]);
    } else {
    const unsigned = { to: tx.to, nonce: tx.nonce, gasLimit: tx.gasLimit, data: tx.data,
      value: tx.value, chainId: tx.chainId, type: tx.type || 0 };
    if (tx.type === 2) { unsigned.maxFeePerGas = tx.maxFeePerGas; unsigned.maxPriorityFeePerGas = tx.maxPriorityFeePerGas; }
    else unsigned.gasPrice = tx.gasPrice;
    if (tx.type === 1 || tx.type === 2) unsigned.accessList = tx.accessList || [];
    raw = utils.serializeTransaction(unsigned, { r: tx.r, s: tx.s, v: tx.v });
    }
  }
  validateRaw(raw, tx.hash);
  return raw;
}
module.exports = { rawTransaction, validateRaw };
