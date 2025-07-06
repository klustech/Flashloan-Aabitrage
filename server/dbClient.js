// server/dbClient.js
const { Pool } = require("pg");
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
    VALUES ($1, $2, $3, $4, $5) RETURNING *;
  `;
  const values = [route, profit, txHash, new Date(timestamp), status];
  const res = await pool.query(query, values);
  return res.rows[0];
}

module.exports = { pool, insertTrade };
