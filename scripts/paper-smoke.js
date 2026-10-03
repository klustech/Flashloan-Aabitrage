const { loadEnvironment, printReport } = require("./paper-preflight");
function assertUnsignedPaper(snapshot) {
  if (
    snapshot?.trading?.state !== "PAPER" ||
    snapshot?.safety?.paperOnly !== true ||
    snapshot.safety.hasPrivateKey !== false
  )
    throw new Error("Running API is not locked unsigned PAPER");
  if (
    snapshot.safety.activity?.signatures !== 0 ||
    snapshot.safety.activity?.submissions !== 0
  )
    throw new Error("Signing/submission activity recorded");
  if (
    snapshot.summary?.pending !== 0 ||
    snapshot.executions?.some((record) => record.mode === "LIVE")
  )
    throw new Error("LIVE ledger activity recorded");
}
function assertPaperSnapshot(snapshot) {
  assertUnsignedPaper(snapshot);
  if (
    !snapshot.latency?.cache?.pools ||
    !(snapshot.latency?.candidates?.indexed > 0)
  )
    throw new Error("Pools/routes not initialized");
  if (
    snapshot.latency?.cache?.lastLogError ||
    snapshot.latency?.cache?.logFallbacks > 0
  )
    throw new Error("Pool log errors require operator review");
}
async function smoke({
  env = process.env,
  request,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = Number(env.PAPER_SMOKE_TIMEOUT_MS || 180000),
  intervalMs = 5000,
} = {}) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < intervalMs ||
    timeoutMs > 600000
  )
    throw new Error("Invalid smoke timeout");
  const base = new URL(env.PAPER_API_URL || "http://127.0.0.1:3001");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    !["http:", "https:"].includes(base.protocol)
  )
    throw new Error("Smoke API must be loopback");
  if (!env.API_KEY) throw new Error("API_KEY missing");
  request ||= async (route) => {
    const response = await fetch(new URL(route, base), {
      headers: { "x-api-key": env.API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("PAPER API request failed");
    return response.json();
  };
  const checks = [];
  let first,
    last,
    health,
    attempts = Math.ceil(timeoutMs / intervalMs);
  const verify = async () => {
    const snapshot = await request("/api/trading");
    assertPaperSnapshot(snapshot);
    const h = await request("/api/trading/paper-health");
    if (
      h.nodeEnv !== "production" ||
      h.chainId !== 1 ||
      h.database !== true ||
      h.runtimeWritable !== true ||
      h.liveRecords !== 0
    )
      throw new Error("Mainnet PAPER persistence/health check failed");
    return { snapshot, health: h };
  };
  try {
    // Allow the first full pool discovery to finish before measuring progress.
    for (let i = 0; i < attempts; i++) {
      const snapshot = await request("/api/trading");
      assertUnsignedPaper(snapshot);
      if (snapshot.latency?.cache?.pools) {
        first = await verify();
        break;
      }
      await wait(intervalMs);
    }
    if (!first) throw new Error("Initial discovery timeout");
    for (let i = 0; i < attempts; i++) {
      await wait(intervalMs);
      const next = await verify();
      last = next.snapshot;
      health = next.health;
      if (
        last.scanner.received > first.snapshot.scanner.received &&
        last.scanner.scans > first.snapshot.scanner.scans &&
        last.latency.cache.block > first.snapshot.latency.cache.block &&
        health.block > first.health.block
      )
        break;
      if (i === attempts - 1) throw new Error("Scanner/block progress timeout");
    }
    checks.push(
      {
        name: "unsigned PAPER / no LIVE activity / healthy persistence",
        passed: true,
      },
      {
        name: "mainnet blocks, scans and cache advancing",
        passed: true,
        detail: {
          block: health.block,
          scans: last.scanner.scans,
          source: last.scanner.source,
          profitableSimulations: last.executions.filter(
            (r) => r.status === "SIMULATED"
          ).length,
        },
      }
    );
    return { ready: true, checks };
  } catch (error) {
    return { ready: false, checks: [{ name: error.message, passed: false }] };
  }
}
if (require.main === module) {
  loadEnvironment();
  smoke()
    .then((report) => {
      printReport(report, "MAINNET PAPER SMOKE — read-only observation");
      process.exitCode = report.ready ? 0 : 1;
    })
    .catch(() => {
      console.error("PAPER smoke failed");
      process.exitCode = 1;
    });
}
module.exports = { smoke, assertPaperSnapshot };
