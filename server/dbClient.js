// server/dbClient.js
const { Pool } = require("pg");
const { BigNumber } = require("ethers");
require("dotenv").config({ override: true });

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});

async function insertTrade(tradeData) {
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

  const values = [
    normalizeValue(route),
    normalizeValue(profit),
    normalizeValue(txHash),
    normalizedTimestamp,
    normalizeValue(status),
  ];
  const res = await pool.query(query, values);
  return res.rows[0];
}

module.exports = { pool, insertTrade };
