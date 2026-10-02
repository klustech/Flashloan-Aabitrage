const { BigNumber, utils } = require('ethers');
const bn = value => BigNumber.from(value);
const ceilDiv = (a, b) => bn(a).add(bn(b).sub(1)).div(b);
const address = value => utils.getAddress(value).toLowerCase();
function integer(value, name, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
function serialize(value) {
  if (BigNumber.isBigNumber(value) || typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,serialize(v)]));
  return value;
}
module.exports = { bn, ceilDiv, address, integer, serialize };
