const fs = require("fs");
const { providers } = require("ethers");
const { productionProfile } = require("../server/config/productionProfile");
const { TokenRegistry } = require("../server/market/tokenRegistry");
const { PoolRegistry, edge } = require("../server/market/poolRegistry");
const { createAdapters } = require("../server/dex");
const { QuoteEngine } = require("../server/bot/quoteEngine");
const { ForkBackend } = require("../server/backrun/forkBackend");
const { address } = require("../server/bot/units");
const { loadEnvironment } = require("./paper-preflight");
const { installArchiveReads } = require("./backrun-archive-reads");
function environment({ onArchiveRetry = () => {}, onMiningProgress = () => {} } = {}) {
  loadEnvironment(process.env);
  if (process.env.PRIVATE_KEY) throw new Error("Historical/PAPER commands refuse PRIVATE_KEY");
  const forkEngine = process.argv.includes("--anvil") ? "anvil" : "hardhat";
  const profile = productionProfile(process.env), url = process.env.MAINNET_RPC_URL;
  if (!url) throw new Error("MAINNET_RPC_URL archive endpoint required");
  const archive = installArchiveReads(new providers.StaticJsonRpcProvider({ url, timeout: 30000,
    throttleLimit: 1, throttleCallback: async () => false }, 1), {
    maxAttempts: process.env.BACKRUN_ARCHIVE_MAX_ATTEMPTS,
    minIntervalMs: process.env.BACKRUN_ARCHIVE_MIN_INTERVAL_MS,
    onRetry: onArchiveRetry,
  });
  // CLI backend transport is separate from the deployed/economic profile:
  // evidence must retain the same fingerprint as PAPER/LIVE commissioning.
  const backend = new ForkBackend({ url: forkEngine === "anvil" ? "http://127.0.0.1:8548" : profile.backrun.forkRpcUrl,
    archiveUrl: url, engine: forkEngine,
    miningTimeoutMs: process.env.BACKRUN_REPLAY_MINING_TIMEOUT_MS || 600000,
    miningProgress: onMiningProgress });
  return { profile, archive, backend, forkEngine };
}
async function topologyContext(profile, provider, blockNumber, poolRefs) {
  const file = process.env.POOL_CACHE_PATH || process.env.POOL_TOPOLOGY_CACHE_PATH || "runtime/mainnet-paper/pool-topology.json";
  const topology = fs.existsSync(file)?JSON.parse(fs.readFileSync(file, "utf8")):
    {pools:(poolRefs||[]).map(ref=>({...profile.routers[ref.dex],dex:ref.dex,poolAddress:ref.address,feeTier:ref.feeTier}))};
  if (!Array.isArray(topology.pools) || !topology.pools.length) throw new Error("Tracked pool topology required");
  const tokens = new TokenRegistry(provider, 1);
  await tokens.load(Object.fromEntries(profile.tokenSymbols.map(s => [s, profile.tokens[s]])), blockNumber);
  const adapters = createAdapters(provider, profile), registry = new PoolRegistry(tokens);
  for (const pool of topology.pools) registry.add({ ...pool, ...await adapters[pool.dex].getPoolState(pool, blockNumber) });
  return { tokens, adapters, registry };
}
function routeFromFixture(fixture, context, profile, block) {
  let token = address(profile.tokens[fixture.borrowSymbol]), legs = [];
  for (const ref of fixture.routePools) {
    const pool = context.registry.values().find(p => p.dex === ref.dex && p.poolAddress === address(ref.address));
    if (!pool) throw new Error("Fixture pool missing from tracked topology");
    const leg = edge(pool, token); legs.push(leg); token = leg.tokenOut;
  }
  if (token !== address(profile.tokens[fixture.borrowSymbol])) throw new Error("Historical fixture route is not a cycle");
  return { id: fixture.name, strategy: "CROSS_DEX_TWO_LEG", chainId: 1, chain: "ethereum",
    borrowToken: token, legs, hops: legs, stateBlock: block };
}
function save(file, data) {
  fs.mkdirSync(require("path").dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
module.exports = { environment, topologyContext, routeFromFixture, save, QuoteEngine };
