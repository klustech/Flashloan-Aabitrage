const fs = require("fs");
const path = require("path");
function writableRuntime(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(
    directory,
    `.paper-probe-${process.pid}-${require("crypto").randomUUID()}`
  );
  try {
    fs.writeFileSync(probe, "probe", { flag: "wx", mode: 0o600 });
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
}
async function paperHealth(coordinator, db) {
  await db.waitForPoolReady();
  if (!db.isDbEnabled() || !db.pool) throw new Error("PostgreSQL unavailable");
  await db.pool.query(
    "SELECT id, mode, status, payload, updated_at FROM executions LIMIT 0"
  );
  const counts = await db.pool.query(
    "SELECT COUNT(*)::int AS count FROM executions WHERE mode='LIVE'"
  );
  writableRuntime(
    path.dirname(coordinator.ledger.file || "runtime/executions.jsonl")
  );
  const network = await coordinator.provider.getNetwork();
  const block = await coordinator.provider.getBlock("latest");
  if (!block?.hash || !block.baseFeePerGas)
    throw new Error("Mainnet head unavailable");
  return {
    nodeEnv: process.env.NODE_ENV,
    chainId: network.chainId,
    block: block.number,
    database: true,
    runtimeWritable: true,
    liveRecords: counts.rows[0].count,
  };
}
module.exports = { paperHealth, writableRuntime };
