const { setTimeout: delay } = require("timers/promises");
const READ_METHODS = new Set(["eth_chainId", "net_version", "eth_blockNumber", "eth_getBlockByNumber",
  "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getRawTransactionByHash",
  "eth_getCode", "eth_getBalance", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
function errorChain(error) {
  const errors = [];
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    errors.push(current); current = current.error || current.cause || current.serverError;
  }
  return errors;
}
function httpStatus(error) {
  for (const current of errorChain(error)) {
    const value = Number(current.status ?? current.statusCode ?? current.response?.status ?? current.response?.statusCode);
    if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
}
function retryableRead(error) {
  const status = httpStatus(error);
  if (status !== undefined) return [408, 429, 500, 502, 503, 504].includes(status);
  return errorChain(error).some(current =>
    ["TIMEOUT", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(current.code) ||
    Number(current.code) === -32005);
}
function integer(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} outside supported range`);
  return parsed;
}
function installArchiveReads(provider, { maxAttempts = 3, minIntervalMs = 150, baseDelayMs = 1000,
  onRetry = () => {}, wait = delay, clock = Date.now } = {}) {
  maxAttempts = integer(maxAttempts, 3, 1, 5, "BACKRUN_ARCHIVE_MAX_ATTEMPTS");
  minIntervalMs = integer(minIntervalMs, 150, 0, 5000, "BACKRUN_ARCHIVE_MIN_INTERVAL_MS");
  baseDelayMs = integer(baseDelayMs, 1000, 0, 10000, "archive retry delay");
  const send = provider.send.bind(provider);
  let gate = Promise.resolve(), nextStart = 0;
  async function pace() {
    const turn = gate.then(async () => {
      const remaining = Math.max(0, nextStart - clock());
      if (remaining) await wait(remaining);
      nextStart = clock() + minIntervalMs;
    });
    gate = turn.catch(() => {}); await turn;
  }
  provider.send = async (method, params) => {
    // Transaction submission and fork mutations are never retried here.
    if (!READ_METHODS.has(method)) return send(method, params);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await pace();
      try { return await send(method, params); }
      catch (error) {
        const retryable = retryableRead(error);
        if (!retryable || attempt === maxAttempts) {
          try { Object.assign(error, { archiveRpcMethod: method, archiveRpcAttempts: attempt, archiveRpcRetryable: retryable }); } catch (_) {}
          throw error;
        }
        const delayMs = Math.min(10000, baseDelayMs * 2 ** (attempt - 1));
        const status = httpStatus(error);
        onRetry({ method, attempt, nextAttempt: attempt + 1, maxAttempts, delayMs,
          ...(status === undefined ? {} : { httpStatus: status }) });
        await wait(delayMs);
      }
    }
  };
  return provider;
}
module.exports = { installArchiveReads, retryableRead, httpStatus };
