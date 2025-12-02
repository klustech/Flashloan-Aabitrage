// server/dbClient.js
const { Pool } = require("pg");
const {
  BigNumber,
  utils: { formatUnits },
} = require("ethers");
const { dbEnabled, dbInsertFailures } = require("./metricsRegistry");
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

dbEnabled.set(0);

let pool = null;
let dbHealthy = false;
let poolInitPromise = null;

const exitIfProduction = (message) => {
  if (process.env.NODE_ENV === "production") {
    console.error(message);
    process.exit(1);
  }
};

const markDbDisabled = (reason, err) => {
  dbHealthy = false;
  dbEnabled.set(0);
  dbInsertFailures.inc();
  if (err) {
    console.error(`${reason}: ${err.message}`);
  } else {
    console.warn(reason);
  }
  if (pool) {
    pool.end().catch(() => undefined);
    pool = null;
  }
  poolInitPromise = null;
  exitIfProduction(
    "[dbClient] Database persistence is required in production. Exiting process."
  );
};

const ensurePoolHealthy = async () => {
  if (!pool) return;
  try {
    await pool.query("SELECT 1;");
    dbHealthy = true;
    dbEnabled.set(1);
    console.info("[dbClient] PostgreSQL connection established.");
  } catch (err) {
    markDbDisabled("[dbClient] Failed to establish PostgreSQL connection", err);
  }
};

if (missingPgVars.length === 0) {
  pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DB,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
  });

  pool.on("error", (err) => {
    markDbDisabled("[dbClient] Unexpected PostgreSQL pool error", err);
  });

  poolInitPromise = ensurePoolHealthy().finally(() => {
    poolInitPromise = null;
  });
} else {
  console.warn(
    `[dbClient] Missing PostgreSQL configuration. Persistence disabled. Missing: ${missingPgVars.join(", ")}`
  );
  dbInsertFailures.inc();
  exitIfProduction(
    "[dbClient] PostgreSQL configuration missing in production. Exiting process."
  );
}

const isDbEnabled = () => dbHealthy;

const makeError = (code, message, extra = {}) => ({
  ok: false,
  error: {
    code,
    message,
    ...extra,
  },
});

const waitForPoolReady = () => poolInitPromise ?? Promise.resolve();

async function insertTrade(tradeData) {
  if (!dbHealthy && poolInitPromise) {
    try {
      await poolInitPromise;
    } catch (_) {
      // ensurePoolHealthy already logged and updated state
    }
  }

  if (!isDbEnabled() || !pool) {
    dbInsertFailures.inc();
    console.info(
      `[dbClient] insertTrade skipped (persistence disabled): ${JSON.stringify(tradeData)}`
    );
    return makeError("DB_DISABLED", "Database persistence is disabled.", {
      retryable: false,
    });
  }

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

  try {
    const res = await pool.query(query, values);
    const inserted = res.rows[0] || null;
    pushTradeToCache(inserted || normalizedRecord);
    return { ok: true, data: inserted };
  } catch (err) {
    dbInsertFailures.inc();
    const poolUnavailable =
      err?.code === "57P01" ||
      err?.code === "57P02" ||
      err?.code === "57P03" ||
      err?.code === "08003" ||
      err?.code === "08006" ||
      /terminated|has ended|already closed/i.test(err?.message || "");

    if (poolUnavailable) {
      dbHealthy = false;
      dbEnabled.set(0);
      console.error(`[dbClient] PostgreSQL pool unavailable: ${err.message}`);
      return makeError("POOL_UNAVAILABLE", "PostgreSQL pool is unavailable.", {
        retryable: true,
        pgCode: err?.code,
      });
    }

    console.error(`[dbClient] Failed to insert trade: ${err.message}`);
    return makeError("DB_INSERT_FAILED", "Failed to insert trade record.", {
      retryable: true,
      pgCode: err?.code,
    });
  }
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
module.exports = {
  pool,
  insertTrade,
  isDbEnabled,
  waitForPoolReady,
  getRecentTrades,
};
