// server/dbClient.js
const { Pool } = require("pg");
const {
  BigNumber,
  utils: { formatUnits },
} = require("ethers");
const { dbEnabled, dbInsertFailures } = require("./metricsRegistry");
require("dotenv").config({ override: true });

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

  try {
    const res = await pool.query(query, values);
    return { ok: true, data: res.rows[0] };
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

module.exports = { pool, insertTrade, isDbEnabled, waitForPoolReady };
