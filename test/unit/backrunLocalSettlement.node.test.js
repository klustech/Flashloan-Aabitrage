const test = require("node:test"), assert = require("node:assert/strict");
const { utils, BigNumber } = require("ethers");
const { measureSettlement, decodeState } = require("../../server/backrun/localExecutorDiagnostic");
const abi = require("../../server/abis/ArbitrageFlashloan.json");
const iface = new utils.Interface(abi), loan = new utils.Interface([
  "event FlashLoan(address indexed target,address indexed initiator,address indexed asset,uint256 amount,uint256 premium,uint16 referralCode)"]);
const addr = n => utils.getAddress("0x" + n.toString(16).padStart(40, "0"));
const bn = n => BigNumber.from(n);
function fixture(fundingMode = "CAPITAL") {
  const executor = { address: addr(1), interface: iface }, recipient = addr(2), tokenAddress = addr(3), other = addr(4), lendingPool = addr(5);
  const log = (contract, intf, name, args) => ({ address: contract, ...intf.encodeEventLog(intf.getEvent(name), args) });
  const profit = fundingMode === "CAPITAL" ? 100 : 93;
  const logs = [log(executor.address, iface, "SwapExecuted", [0, tokenAddress, other, 1000, 2000]),
    log(executor.address, iface, "SwapExecuted", [0, other, tokenAddress, 2000, 1100]),
    log(executor.address, iface, "ProfitWithdrawn", [tokenAddress, recipient, profit])];
  if (fundingMode === "FLASH_LOAN") logs.push(log(lendingPool, loan, "FlashLoan", [executor.address, executor.address, tokenAddress, 1000, 7, 0]));
  return { receipt: { status: 1, logs, gasUsed: bn(100), effectiveGasPrice: bn(2) }, executor, tokenAddress, recipient,
    recipientBefore: bn(0), recipientAfter: bn(profit), principalBefore: bn(1000), principalAfter: bn(1000),
    nativeBefore: bn(10000), nativeAfter: bn(9800), amount: bn(1000), lendingPool, fundingMode, minimumProfit: bn(1),
    steps: [{ tokenIn: tokenAddress, tokenOut: other }, { tokenIn: other, tokenOut: tokenAddress }] };
}

test("successful settlement is reported as unprofitable when measured gas consumes the edge", () => {
  const result = measureSettlement(fixture());
  assert.equal(result.executionSucceeded, true); assert.equal(result.netPositive, false);
  assert.equal(result.grossBeforeFundingFee, "100"); assert.equal(result.profitWithdrawn, "100");
  assert.equal(result.gasCostNative, "200"); assert.equal(result.netAfterGasNative, "-100");
  assert.equal(result.meetsConfiguredMinimum, false);
});

test("flash fee comes from actual swaps and Aave receipt and is never deducted twice", () => {
  const result = measureSettlement(fixture("FLASH_LOAN"));
  assert.equal(result.flashloanFee, "7"); assert.equal(result.grossBeforeFundingFee, "100");
  assert.equal(result.profitWithdrawn, "93"); assert.equal(result.netAfterGasNative, "-107");
});

test("settlement rejects recipient, principal, native gas and Aave fee mismatches", () => {
  for (const changes of [{ recipientAfter: bn(99) }, { principalAfter: bn(999) }, { nativeAfter: bn(9900) }])
    assert.throws(() => measureSettlement({ ...fixture(), ...changes }), /balance|principal|gas accounting/);
  const input = fixture("FLASH_LOAN");
  input.receipt.logs.at(-1).data = loan.encodeEventLog(loan.getEvent("FlashLoan"),
    [input.executor.address, input.executor.address, input.tokenAddress, 1000, 6, 0]).data;
  assert.throws(() => measureSettlement(input), /Aave flash-loan receipt mismatch/);
});

test("Anvil state decoding supports plain and compressed dump formats", () => {
  const json = JSON.stringify({ accounts: { [addr(1)]: { nonce: 1, storage: {} } } });
  const expected = JSON.parse(json);
  assert.deepEqual(decodeState("0x" + Buffer.from(json).toString("hex")), expected);
  assert.deepEqual(decodeState("0x" + require("zlib").gzipSync(json).toString("hex")), expected);
});

test("local executor CLI refuses an execution key before starting a node or contacting the archive", () => {
  const { spawnSync } = require("child_process"), path = require("path");
  const secret = "test-execution-key-must-never-be-used";
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/backrun-executor-fork.js")], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, PRIVATE_KEY: secret,
      PAPER_ENV_FILE: "nonexistent-diagnostic-test.env", MAINNET_RPC_URL: "https://not-contacted.invalid/private-path" },
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  const diagnostic = JSON.parse(result.stderr);
  assert.equal(diagnostic.proofIssued, false); assert.match(diagnostic.message, /refuse PRIVATE_KEY/);
  assert.ok(!result.stderr.includes(secret)); assert.ok(!result.stderr.includes("private-path"));
});
