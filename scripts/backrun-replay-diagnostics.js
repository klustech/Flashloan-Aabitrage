const { httpStatus } = require("./backrun-archive-reads");
function redact(value, env = process.env) {
  let text = String(value ?? "");
  for (const [name, secret] of Object.entries(env)) {
    if (/(?:KEY|PASSWORD|SECRET|TOKEN|URL|WEBSOCKET)/i.test(name) &&
        typeof secret === "string" && secret.length >= 4) {
      for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))
        text = text.split(form).join("[redacted]");
    }
  }
  return text.replace(/\s*\((?:error|body|requestBody|response|code|value|argument|data|transaction|method)=.*$/s, "")
    .replace(/https?:[\\/]{2,}[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/0x[0-9a-f]{64,}/gi, "[redacted-hex]").slice(0, 800);
}

function replayDiagnostic(error, context = {}, env = process.env) {
  const diagnostic = {
    kind: "BACKRUN_REPLAY_FAILED",
    stage: context.stage || "unknown",
    proofIssued: false,
    message: redact(error?.reason || error?.message || error, env),
  };
  for (const key of ["blockNumber", "transactionIndex", "transactionType", "endIndex"])
    if (Number.isInteger(context[key])) diagnostic[key] = context[key];
  if (typeof error?.code === "string" || typeof error?.code === "number")
    diagnostic.code = redact(error.code, env);
  for (const key of ["transactionChainId", "signatureV"])
    if (Number.isInteger(error?.[key])) diagnostic[key] = error[key];
  const status = httpStatus(error);
  if (status !== undefined) diagnostic.httpStatus = status;
  if (/^(?:eth|net|web3)_[A-Za-z0-9]+$/.test(error?.archiveRpcMethod || "")) diagnostic.rpcMethod = error.archiveRpcMethod;
  if (/^(?:eth|net|web3|hardhat|anvil|evm)_[A-Za-z0-9]+$/.test(error?.forkRpcMethod || "")) {
    diagnostic.rpcMethod = error.forkRpcMethod;
    diagnostic.rpcSurface = "local_fork";
    if (Array.isArray(error.forkRpcParameterTypes))
      diagnostic.parameterTypes = error.forkRpcParameterTypes.filter(type =>
        ["string", "number", "boolean", "object", "array", "null", "undefined"].includes(type)).slice(0, 8);
  }
  if (Number.isInteger(error?.replayTransactionIndex)) diagnostic.transactionIndex = error.replayTransactionIndex;
  if (Number.isInteger(error?.replayTransactionType)) diagnostic.transactionType = error.replayTransactionType;
  if (Number.isInteger(error?.forkMiningTimeoutMs)) diagnostic.timeoutMs = error.forkMiningTimeoutMs;
  if (Number.isInteger(error?.forkMiningElapsedMs)) diagnostic.elapsedMs = error.forkMiningElapsedMs;
  if (typeof error?.forkMiningOutcomeUnknown === "boolean") diagnostic.miningOutcomeUnknown = error.forkMiningOutcomeUnknown;
  if (Number.isInteger(error?.archiveRpcAttempts)) diagnostic.attempts = error.archiveRpcAttempts;
  if (typeof error?.archiveRpcRetryable === "boolean") diagnostic.retryable = error.archiveRpcRetryable;
  const nested = error?.error?.reason || error?.error?.message || error?.cause?.message;
  if (nested) diagnostic.rpcMessage = redact(nested, env);
  const causes = [];
  let cause = error?.error || error?.cause || error?.serverError;
  for (let depth = 0; cause && depth < 4; depth++, cause = cause.error || cause.cause || cause.serverError) {
    const detail = {};
    if (typeof cause.code === "string" || typeof cause.code === "number") detail.code = redact(cause.code, env);
    if (cause.reason || cause.message) detail.message = redact(cause.reason || cause.message, env);
    if (Number.isInteger(cause.status) || Number.isInteger(cause.statusCode)) detail.httpStatus = cause.status || cause.statusCode;
    if (Object.keys(detail).length) causes.push(detail);
  }
  if (causes.length) diagnostic.causes = causes;
  return diagnostic;
}

module.exports = { redact, replayDiagnostic };
