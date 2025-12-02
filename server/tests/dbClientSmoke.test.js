const assert = require("assert");

(async () => {
  const dbClient = require("../dbClient");

  await dbClient.waitForPoolReady();

  const expectedExports = [
    "pool",
    "insertTrade",
    "isDbEnabled",
    "waitForPoolReady",
    "getRecentTrades",
  ];

  expectedExports.forEach((key) => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(dbClient, key),
      `dbClient should export ${key}`
    );
  });

  assert.strictEqual(
    typeof dbClient.insertTrade,
    "function",
    "insertTrade should be a function"
  );
  assert.strictEqual(
    typeof dbClient.isDbEnabled,
    "function",
    "isDbEnabled should be a function"
  );
  assert.strictEqual(
    typeof dbClient.waitForPoolReady,
    "function",
    "waitForPoolReady should be a function"
  );
  assert.strictEqual(
    typeof dbClient.getRecentTrades,
    "function",
    "getRecentTrades should be a function"
  );

  if (dbClient.pool && typeof dbClient.pool.end === "function") {
    await dbClient.pool.end();
  }

  console.log("dbClient smoke test passed");
})().catch((err) => {
  console.error("dbClient smoke test failed", err);
  process.exitCode = 1;
});
