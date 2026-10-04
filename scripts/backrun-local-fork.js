const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { setTimeout: delay } = require("timers/promises");

async function probeFork(url) {
  const request = async method => {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw new Error("Local fork HTTP request failed");
    const result = await response.json();
    if (result.error) throw new Error("Local fork RPC request failed");
    return result.result;
  };
  try {
    const [client, chain] = await Promise.all([request("web3_clientVersion"), request("eth_chainId")]);
    return /^HardhatNetwork\//.test(client) && Number(chain) === 1;
  } catch (_) { return false; }
}

async function withLocalFork(profile, work, progress = () => {}) {
  const url = profile.backrun.forkRpcUrl, parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.port !== "8547")
    throw new Error("--local requires BACKRUN_FORK_RPC_URL=http://127.0.0.1:8547");
  progress({ stage: "local_fork_probe" });
  if (await probeFork(url)) {
    progress({ stage: "local_fork_reusing_existing" });
    return work();
  }

  const log = path.resolve("runtime/backrun/fork.log");
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(log, "a", 0o600);
  fs.fchmodSync(fd, 0o600);
  const grouped = process.platform !== "win32";
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, "backrun-fork-node.js")], {
      stdio: ["ignore", fd, fd], env: process.env, detached: grouped,
    });
  } finally { fs.closeSync(fd); }
  let stopped = false, spawnError;
  child.once("error", error => { spawnError = error; });
  const exited = new Promise(resolve => child.once("close", resolve));
  function stop(signal = "SIGTERM") {
    try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); } catch (_) {}
  }
  const interrupt = () => { stop(); process.exit(130); };
  const terminate = () => { stop(); process.exit(143); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  exited.then(() => { stopped = true; });
  try {
    progress({ stage: "local_fork_start" });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (stopped) throw new Error("Local fork exited during startup; inspect private runtime/backrun/fork.log");
      if (await probeFork(url)) {
        progress({ stage: "local_fork_ready" });
        return await work();
      }
      await delay(200);
    }
    throw new Error("Local fork did not become ready within 30 seconds");
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    stop();
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, 5000); });
    await Promise.race([exited, timeout]);
    clearTimeout(timer);
    if (!stopped) { stop("SIGKILL"); await exited; }
  }
}

module.exports = { probeFork, withLocalFork };
