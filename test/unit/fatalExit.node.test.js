const test = require("node:test");
const assert = require("node:assert");
const { createFatalExit } = require("../../server/utils/fatalExit");

test("a fatal error schedules exactly one non-zero exit outside tests", async () => {
  const codes = [];
  const before = process.exitCode;
  const exitAfterFatal = createFatalExit({
    env: { NODE_ENV: "production" },
    exit: (c) => codes.push(c),
    delayMs: 5,
  });
  try {
    assert.equal(exitAfterFatal(), true);
    assert.equal(
      exitAfterFatal(),
      false,
      "a second fatal error must not schedule another exit"
    );
    assert.equal(process.exitCode, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(codes, [1]);
  } finally {
    process.exitCode = before;
  }
});

test("under NODE_ENV=test the listeners only log and the process keeps running", async () => {
  const codes = [];
  const exitAfterFatal = createFatalExit({
    env: { NODE_ENV: "test" },
    exit: (c) => codes.push(c),
    delayMs: 1,
  });
  assert.equal(exitAfterFatal(), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(codes, []);
});
