// server/dbClient.js
const { Pool } = require("pg");
const {
  BigNumber,
  utils: { formatUnits },
} = require("ethers");
require("dotenv").config({ override: true });

const TRADE_CACHE_LIMIT =
  parseInt(process.env.TRADE_CACHE_LIMIT, 10) > 0
    ? parseInt(process.env.TRADE_CACHE_LIMIT, 10)
    : 100;
const tradeHistoryCache = [];

const toDate = (value) => {
  if (!value) return new Date();
  if (
    typeof BigNumber?.isBigNumber === "function" &&
    BigNumber.isBigNumber(value)
  ) {
    return new Date(value.toNumber());
  }
  if (value instanceof Date) return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return new Date(Number(value));
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const normalizeTradeRecord = (record) => {
  if (!record) return null;

  const profitValue = record.profit ?? record.profit_dai ?? record.profitDai;
  const txHashValue = record.txHash ?? record.tx_hash ?? null;
  const timestampValue = record.timestamp ?? record.executedAt ?? null;

  return {
    id: record.id ?? null,
    route: record.route ?? null,
    profit:
      profitValue === null || profitValue === undefined
        ? null
        : profitValue.toString(),
    txHash: txHashValue,
    timestamp: toDate(timestampValue).toISOString(),
    status: record.status ?? null,
  };
};

const pushTradeToCache = (record) => {
  const normalized = normalizeTradeRecord(record);
  if (!normalized) return null;
  tradeHistoryCache.unshift(normalized);
  if (tradeHistoryCache.length > TRADE_CACHE_LIMIT) {
    tradeHistoryCache.length = TRADE_CACHE_LIMIT;
  }
  return normalized;
};

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
  const { route, profit, txHash, timestamp, status } = tradeData;
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

  const normalizedRecord = {
    route: normalizeValue(route),
    profit: normalizedProfit,
    txHash: normalizeValue(txHash),
    timestamp: normalizedTimestamp,
    status: normalizeValue(status),
  };

  if (!isDbEnabled()) {
    console.info(
      `[dbClient] insertTrade skipped (persistence disabled): ${JSON.stringify(tradeData)}`
    );
    pushTradeToCache(normalizedRecord);
    return null;
  }

  const query = `
    INSERT INTO trades (route, profit, tx_hash, timestamp, status)
    VALUES ($1, $2::numeric, $3, $4, $5) RETURNING *;
  `;

  const values = [
    normalizeValue(route),
    normalizedProfit,
    normalizeValue(txHash),
    normalizedTimestamp,
    normalizeValue(status),
  ];
  const res = await pool.query(query, values);
  const inserted = res.rows[0];
  pushTradeToCache(inserted || normalizedRecord);
  return inserted;
}

async function getRecentTrades(limit = 50) {
  const normalizedLimit = Number.isFinite(Number(limit))
    ? Math.min(Math.max(parseInt(limit, 10), 1), 200)
    : 50;

  if (isDbEnabled()) {
    try {
      const res = await pool.query(
        `SELECT id, route, profit, tx_hash AS "txHash", timestamp, status
         FROM trades
         ORDER BY timestamp DESC
         LIMIT $1;`,
        [normalizedLimit]
      );

      const rows = res.rows.map((row) => normalizeTradeRecord(row));
      if (rows.length) {
        tradeHistoryCache.length = 0;
        tradeHistoryCache.push(...rows.slice(0, TRADE_CACHE_LIMIT));
      }
      return rows;
    } catch (error) {
      console.error(`[dbClient] Failed to fetch trades from DB: ${error.message}`);
    }
  }

  return tradeHistoryCache.slice(0, normalizedLimit);
}

module.exports = { pool, insertTrade, isDbEnabled, getRecentTrades };
