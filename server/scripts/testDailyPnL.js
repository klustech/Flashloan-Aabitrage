#!/usr/bin/env node
const crypto = require("crypto");
const { BigNumber } = require("ethers");
const { insertTrade, pool } = require("../dbClient");
const { computeDailyPnL } = require("../botLogic");

require("dotenv").config({ override: true });

async function main() {
  const baseline = await computeDailyPnL();

  const tradeData = {
    route: "integration-test",
    profit: BigNumber.from("1000000000000000000"),
    txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
    timestamp: new Date().toISOString(),
    status: "test",
  };

  const inserted = await insertTrade(tradeData);
  if (!inserted.ok) {
    throw new Error(
      `insertTrade failed (${inserted.error.code}): ${inserted.error.message}`
    );
  }

  const updatedPnL = await computeDailyPnL();
  const expected = baseline.add(tradeData.profit);

  if (!BigNumber.isBigNumber(updatedPnL)) {
    throw new Error("computeDailyPnL did not return a BigNumber instance");
  }

  if (!updatedPnL.eq(expected)) {
    throw new Error(
      `Unexpected PnL. Expected ${expected.toString()} but received ${updatedPnL.toString()}`
    );
  }

  console.log(
    `PnL round-trip succeeded. Baseline=${baseline.toString()} Updated=${updatedPnL.toString()}`
  );

  if (inserted.data && inserted.data.tx_hash) {
    await pool.query("DELETE FROM trades WHERE tx_hash = $1", [inserted.data.tx_hash]);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
