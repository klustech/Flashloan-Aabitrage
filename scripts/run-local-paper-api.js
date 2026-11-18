#!/usr/bin/env node
"use strict";

// Starts the existing API against the isolated local fork configuration.
const path = require("path");
const dotenv = require("dotenv");

const envPath = path.resolve("runtime/local-paper.env");
const loaded = dotenv.config({ path: envPath, override: true });
if (loaded.error) {
  console.error("[LOCAL PAPER] Missing runtime/local-paper.env. Run npm run local-paper:deploy first.");
  process.exit(1);
}
if (process.env.PAPER_ONLY !== "true" || process.env.PRIVATE_KEY?.trim()) {
  console.error("[LOCAL PAPER] Refusing API startup: unsigned PAPER safeguards are not satisfied.");
  process.exit(1);
}
if (process.env.MAINNET_RPC_URL !== "http://127.0.0.1:18545") {
  console.error("[LOCAL PAPER] Refusing API startup: RPC is not the isolated local fork.");
  process.exit(1);
}

const { start } = require("../server/scripts/server");
start(Number(process.env.PORT || 3001)).catch((error) => {
  console.error("[LOCAL PAPER] API startup failed:", error.message);
  process.exitCode = 1;
});
