// Runs a validation harness (failure injection, restart recovery) in a child
// process with the isolated test environment. The harnesses drive the LIVE
// code path against stub providers and relays; running them here keeps the
// operator's PAPER_ONLY and database settings intact in the parent process
// instead of switching them off in-process.
const path = require("path");
const { spawnSync } = require("child_process");
const { testEnv } = require("./testEnv");

const MARKER = "\n@@HARNESS_RESULT@@";

function runIsolated(modulePath, exportName, { env = process.env, timeoutMs = 300000 } = {}) {
  const code = `require(${JSON.stringify(path.resolve(modulePath))}).${exportName}()` +
    `.then(r => process.stdout.write(${JSON.stringify(MARKER)} + JSON.stringify(r)))` +
    `.catch(e => { console.error(e && e.stack || e); process.exitCode = 1; })`;
  const r = spawnSync(process.execPath, ["-e", code], { env: testEnv(env), encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 << 20 });
  const at = (r.stdout || "").lastIndexOf(MARKER);
  if (at < 0) {
    const why = r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
    throw new Error(`${exportName} harness produced no result (${why}): ${String(r.stderr || "").trim().split("\n").slice(-5).join(" | ")}`);
  }
  return JSON.parse(r.stdout.slice(at + MARKER.length));
}

module.exports = { runIsolated };
