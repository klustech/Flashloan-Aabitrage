const { rateLimit } = require("express-rate-limit");
const OPEN_PATHS = new Set(["/healthz", "/health", "/metrics"]);
function createApiRateLimits({
  windowMs = 300000,
  reads = 600,
  mutations = 30,
} = {}) {
  const make = (limit) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        error: "Too many requests; retry after the rate-limit window.",
      },
    });
  const read = make(reads),
    settings = make(mutations),
    trading = make(mutations),
    other = make(mutations);
  return (req, res, next) => {
    // Auth runs before this middleware. Emergency disarming must remain usable.
    if (
      OPEN_PATHS.has(req.path) ||
      req.method === "OPTIONS" ||
      (req.method === "POST" &&
        ["/api/trading/pause", "/api/stop-bot"].includes(req.path))
    )
      return next();
    if (["GET", "HEAD"].includes(req.method)) return read(req, res, next);
    if (req.path.startsWith("/api/settings")) return settings(req, res, next);
    if (req.path.startsWith("/api/trading/")) return trading(req, res, next);
    return other(req, res, next);
  };
}
module.exports = { createApiRateLimits, OPEN_PATHS };
