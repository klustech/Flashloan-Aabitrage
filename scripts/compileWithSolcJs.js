#!/usr/bin/env node
/**
 * Offline Solidity compiler + ABI generator using the in-process `solc` npm
 * package (no binary download required).
 *
 * Purpose:
 *   - Verify that contracts compile in restricted-network environments where
 *     Hardhat cannot download solc from binaries.soliditylang.org.
 *   - Regenerate the ABI JSON consumed by the bot/frontend directly from the
 *     contract source, so the off-chain ABI can never drift from on-chain code.
 *
 * Usage:
 *   node scripts/compileWithSolcJs.js            # compile + write artifacts-solcjs/
 *   node scripts/compileWithSolcJs.js --sync-abi # also copy ABIs to app locations
 *
 * In a normal environment prefer `npx hardhat compile`; this is a fallback.
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const OUT_DIR = path.join(ROOT, "artifacts-solcjs");

// ABI destinations kept in sync with the contract source.
const ABI_SYNC = {
  ArbitrageFlashloan: [
    "server/abis/ArbitrageFlashloan.json",
    "server/scripts/abis/ArbitrageFlashloan.json",
    "server/scripts/abis/ArbitrageFlashloanABI.json",
    "frontend/src/abis/ArbitrageFlashloan.json",
  ],
};

function readLocalSources() {
  const sources = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".sol")) {
        const rel = path.relative(ROOT, full).split(path.sep).join("/");
        sources[rel] = { content: fs.readFileSync(full, "utf8") };
      }
    }
  })(CONTRACTS_DIR);
  return sources;
}

function findImports(importPath) {
  const candidates = [];
  if (importPath.startsWith("@")) {
    candidates.push(path.join(ROOT, "node_modules", importPath));
  } else {
    candidates.push(path.join(ROOT, importPath));
    candidates.push(path.join(ROOT, "node_modules", importPath));
  }
  for (const c of candidates) {
    try {
      return { contents: fs.readFileSync(c, "utf8") };
    } catch (_) {
      /* try next */
    }
  }
  return { error: `File not found: ${importPath}` };
}

function main() {
  const input = {
    language: "Solidity",
    sources: readLocalSources(),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  );

  let hasError = false;
  for (const err of output.errors || []) {
    if (err.severity === "error") {
      hasError = true;
      console.error(err.formattedMessage);
    } else if (!/SPDX|Unused|Function state mutability/.test(err.message)) {
      console.warn(err.formattedMessage);
    }
  }
  if (hasError) {
    console.error("\n❌ COMPILE FAILED");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const abis = {};
  for (const file of Object.keys(output.contracts || {})) {
    for (const name of Object.keys(output.contracts[file])) {
      const c = output.contracts[file][name];
      abis[name] = c.abi;
      fs.writeFileSync(
        path.join(OUT_DIR, `${name}.json`),
        JSON.stringify(
          {
            contractName: name,
            abi: c.abi,
            bytecode: `0x${c.evm.bytecode.object}`,
          },
          null,
          2
        )
      );
    }
  }
  console.log(
    `✅ COMPILE OK — ${Object.keys(abis).length} contracts → artifacts-solcjs/`
  );

  if (process.argv.includes("--sync-abi")) {
    for (const [name, dests] of Object.entries(ABI_SYNC)) {
      if (!abis[name]) continue;
      for (const dest of dests) {
        const full = path.join(ROOT, dest);
        if (!fs.existsSync(path.dirname(full))) continue;
        fs.writeFileSync(full, JSON.stringify(abis[name], null, 2));
        console.log(`   synced ABI ${name} → ${dest}`);
      }
    }
  }
}

main();
