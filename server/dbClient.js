// server/dbClient.js
const { Pool } = require("pg");
const {
  BigNumber,
  utils: { formatUnits },
} = require("ethers");
require("dotenv").config({ override: true });

const requiredPgVars = ["PG_USER", "PG_HOST", "PG_DB", "PG_PASSWORD", "PG_PORT"];
const missingPgVars = requiredPgVars.filter((key) => !process.env[key]);

let pool = null;
if (missingPgVars.length === 0) {
  pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DB,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
  });
} else {
  console.warn(
    `[dbClient] Missing PostgreSQL configuration. Persistence disabled. Missing: ${missingPgVars.join(
      ", "
    )}`
  );
}

const isDbEnabled = () => Boolean(pool);

async function insertTrade(tradeData) {
  if (!isDbEnabled()) {
    console.info(
      `[dbClient] insertTrade skipped (persistence disabled): ${JSON.stringify(tradeData)}`
    );
    return null;
  }

  const { route, profit, txHash, timestamp, status } = tradeData;
  const query = `
    INSERT INTO trades (route, profit, tx_hash, timestamp, status)
    VALUES ($1, $2::numeric, $3, $4, $5) RETURNING *;
  `;
  const normalizeValue = (value) =>
    typeof BigNumber.isBigNumber === "function" && BigNumber.isBigNumber(value)
      ? value.toString()
      : value;

  const normalizedTimestamp =
    typeof BigNumber.isBigNumber === "function" &&
    BigNumber.isBigNumber(timestamp)
      ? new Date(timestamp.toNumber())
      : new Date(timestamp);

  const normalizedProfit = BigNumber.isBigNumber(profit)
    ? formatUnits(profit, 18)
    : typeof profit === "bigint"
    ? profit.toString()
    : normalizeValue(profit);

  const values = [
    normalizeValue(route),
    normalizedProfit,
    normalizeValue(txHash),
    normalizedTimestamp,
    normalizeValue(status),
  ];
  const res = await pool.query(query, values);
  return res.rows[0];
}

module.exports = { pool, insertTrade, isDbEnabled };
