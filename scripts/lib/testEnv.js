// Test isolation. Tests and validation harnesses must not inherit the
// operator environment: PAPER_ONLY=true would make LIVE-path tests fail,
// PostgreSQL settings would open real connections, and a fork RPC would
// pull fork tests into ordinary runs. Shell variables are allow-listed, and
// every key defined in a local dotenv file is pre-set to empty so modules
// that call dotenv.config() (which never overrides an existing key) cannot
// re-inject it.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NVM_[A-Z_]+|npm_[A-Za-z_]+|NPM_CONFIG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_(FILE|DIR)|CI|GITHUB_[A-Z_]+|RUNNER_[A-Z_]+|XDG_[A-Z_]+|SYSTEMROOT|COMSPEC|APPDATA|LOCALAPPDATA|USERPROFILE|PLAYWRIGHT_[A-Z_]+)$/;
const ALWAYS_BLANK = ["PAPER_ONLY", "PRIVATE_KEY", "LOCAL_BACKRUN_TEST_RPC", "LOCAL_BACKRUN_TEST_ENGINE", "PG_USER", "PG_HOST", "PG_DB",
  "PG_PASSWORD", "PG_PORT", "DATABASE_URL", "MAINNET_RPC_URL", "MAINNET_WEBSOCKET", "RELAY_AUTH_PRIVATE_KEY", "FLASHBOTS_AUTH_KEY"];

function dotenvKeys(root = ROOT) {
  const keys = new Set();
  for (const dir of [root, path.join(root, "server")]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /^\.env(\..+)?$/.test(n)); } catch (_) {}
    for (const name of names) {
      let text = "";
      try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch (_) { continue; }
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m) keys.add(m[1]);
      }
    }
  }
  return keys;
}

function testEnv(env = process.env, { root = ROOT, extra = {} } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (KEEP.test(key)) out[key] = value;
  for (const key of dotenvKeys(root)) if (!KEEP.test(key)) out[key] = "";
  for (const key of ALWAYS_BLANK) out[key] = "";
  // Point the PAPER profile loader at a file that does not exist.
  out.PAPER_ENV_FILE = path.join(root, ".env.isolated-test-does-not-exist");
  out.NODE_ENV = "test";
  return { ...out, ...extra };
}

module.exports = { testEnv, dotenvKeys, KEEP, ALWAYS_BLANK };
