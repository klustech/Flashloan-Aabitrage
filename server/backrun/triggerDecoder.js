const { utils } = require("ethers");
const { address, bn } = require("../bot/units");
const SWAP_TOPICS = new Set([
  utils.id("Swap(address,uint256,uint256,uint256,uint256,address)").toLowerCase(),
  utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)").toLowerCase(),
  utils.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)").toLowerCase(),
]);
const V2 = new utils.Interface([
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] path,address to,uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable",
  "function swapETHForExactTokens(uint256 amountOut,address[] path,address to,uint256 deadline) payable",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapTokensForExactETH(uint256 amountOut,uint256 amountInMax,address[] path,address to,uint256 deadline)",
]);
const V3 = new utils.Interface([
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)",
  "function exactOutputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params)",
  "function exactInput(tuple(bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params)",
  "function exactOutput(tuple(bytes path,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum) params)",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline,bytes[] data)",
]);
// SwapRouter02 omits the deadline in its exact-swap structs.
const V3_02 = new utils.Interface([
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)",
  "function exactOutputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params)",
  "function exactInput(tuple(bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params)",
  "function exactOutput(tuple(bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum) params)",
]);
function v3Path(path, reverse = false) {
  const bytes = utils.arrayify(path);
  if (bytes.length < 43 || (bytes.length - 20) % 23 || bytes.length > 20 + 23 * 8)
    throw new Error("Invalid V3 swap path");
  const tokens = [], fees = [];
  for (let i = 0; i < bytes.length; i += 23) {
    tokens.push(address(utils.hexlify(bytes.slice(i, i + 20))));
    if (i + 20 < bytes.length) fees.push(bytes[i + 20] * 65536 + bytes[i + 21] * 256 + bytes[i + 22]);
  }
  if (reverse) { tokens.reverse(); fees.reverse(); }
  return { tokens, fees };
}
function decodeRouter(transaction, registry) {
  if (!transaction?.to || !transaction.data || transaction.data.length > 131074) return [];
  const pools = registry.values().filter(p => address(p.router) === address(transaction.to));
  if (!pools.length) return [];
  const swaps = [];
  function decode(data, depth) {
    if (depth > 3) throw new Error("Router multicall nesting limit");
    let call;
    for (const abi of [V2, V3, V3_02]) { try { call = abi.parseTransaction({ data }); break; } catch (_) {} }
    if (!call) throw new Error("Unsupported router calldata");
    if (call.name === "multicall") {
      const nested = call.args.data;
      if (nested.length > 16) throw new Error("Router multicall size limit");
      for (const inner of nested) decode(inner, depth + 1);
      return;
    }
    let path, fees = [], amountIn, minAmountOut, exactOutput = /Exact|exactOutput/.test(call.name) && !/^swapExact/.test(call.name);
    if (call.name.startsWith("swap")) {
      path = call.args.path.map(address);
      amountIn = call.args.amountIn ?? call.args.amountInMax ?? transaction.value ?? 0;
      minAmountOut = call.args.amountOutMin ?? call.args.amountOut;
    } else {
      const p = call.args.params;
      amountIn = p.amountIn ?? p.amountInMaximum;
      minAmountOut = p.amountOutMinimum ?? p.amountOut;
      if (p.path) ({ tokens: path, fees } = v3Path(p.path, exactOutput));
      else { path = [address(p.tokenIn), address(p.tokenOut)]; fees = [Number(p.fee)]; }
    }
    if (path.length < 2 || path.length > 9) throw new Error("Unsupported swap path");
    for (let i = 0; i < path.length - 1; i++) {
      const matches = pools.filter(p => [p.token0, p.token1].includes(path[i]) &&
        [p.token0, p.token1].includes(path[i + 1]) &&
        (fees.length ? p.protocolVersion === 3 && p.feeTier === fees[i] : p.protocolVersion === 2));
      if (matches.length !== 1) throw new Error("Swap pool untracked or ambiguous");
      swaps.push({ dex: matches[0].dex, poolAddress: matches[0].poolAddress, tokenIn: path[i],
        tokenOut: path[i + 1], amountIn: bn(amountIn), minAmountOut: bn(minAmountOut),
        exactOutput, amountIsRouteBound: true });
    }
  }
  decode(transaction.data, 0);
  return swaps;
}
function decodeTriggerHint(hint, registry) {
  if (!hint || typeof hint !== "object") throw new Error("order-flow hint required");
  const tracked = new Set(registry.values().map(p => address(p.poolAddress))), affected = new Set();
  let swaps = [], decodingMethod = "tracked_pool_hint";
  for (const pool of hint.affectedPools || []) { try { const p = address(pool); if (tracked.has(p)) affected.add(p); } catch (_) {} }
  for (const log of hint.logs || []) {
    try { const p = address(log.address); if (tracked.has(p) && SWAP_TOPICS.has(String(log.topics?.[0]).toLowerCase())) affected.add(p); } catch (_) {}
  }
  try {
    swaps = decodeRouter(hint.transaction || hint, registry);
    if (swaps.length) { decodingMethod = "router_calldata"; for (const s of swaps) affected.add(s.poolAddress); }
  } catch (_) { decodingMethod = "simulation_required"; }
  // A fully signed transaction may be resolved by its actual simulated logs.
  // Hints alone do not establish a post-trigger state.
  const usable = affected.size > 0 || Boolean(hint.rawTx);
  return { ...hint, hash: hint.hash || null, rawTx: hint.rawTx || null, swaps,
    affectedPools: [...affected], affectedTokens: [...new Set(swaps.flatMap(s => [s.tokenIn, s.tokenOut]))],
    receivedAt: hint.receivedAt || Date.now(), decodingMethod, usable,
    reason: usable ? null : "no_tracked_pool_impact_hint" };
}
module.exports = { decodeTriggerHint, decodeRouter, v3Path, SWAP_TOPICS, V2, V3, V3_02 };
