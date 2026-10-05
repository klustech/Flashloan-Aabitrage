const zlib = require("zlib");
const { EXECUTOR_VERSION } = require("../config/executorVersion");
const { Contract, ContractFactory, Wallet, utils } = require("ethers");
const { bn, address, serialize } = require("../bot/units");
const { verifyReceipts } = require("./historicalReplay");
const { latestBlock } = require("./forkBackend");
const TOKEN = ["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  "function deposit() payable", "function transfer(address,uint256) returns(bool)"];
const AAVE_EVENT = new utils.Interface(["event FlashLoan(address indexed target,address indexed initiator,address indexed asset,uint256 amount,uint256 premium,uint16 referralCode)"]);

function decodeState(raw) {
  const bytes = Buffer.from(raw.slice(2), "hex");
  return JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes).toString("utf8"));
}
function stateAccount(state, account) {
  const entry = Object.entries(state.accounts || {}).find(([key]) => address(key) === address(account));
  if (!entry) throw new Error("Local deployment account missing from Anvil state");
  return entry[1];
}
const slotHex = slot => utils.hexZeroPad(utils.hexValue(bn(slot)), 32);

// Diagnostic only: real constructor deployment and a real wrapped-native deposit,
// funded with explicitly synthetic native currency on the dedicated local node.
// Preserve the resulting LOCAL accounts across reset, without changing historical
// pool/router/Aave state or putting setup transactions inside a canonical prefix.
async function prepareLocalExecutor({ backend, parent, artifact, addressesProvider, lendingPool, wrappedNative, amount, routers, progress = () => {} }) {
  if (!Array.isArray(routers) || !routers.length) throw new Error("Local executor requires approved routers");
  if (backend.engine !== "anvil") throw new Error("Local executor diagnostic requires Anvil");
  backend.assertMiningSettled();
  const originalReset = backend.reset.bind(backend), provider = backend.provider;
  await originalReset(parent);
  // `owner` is the local hot executor and profit recipient; `governance` is a
  // separate local admin that never sends a transaction.
  const owner = Wallet.createRandom().address, governance = Wallet.createRandom().address;
  const executorAddress = utils.getContractAddress({ from: owner, nonce: 0 });
  for (const account of [owner, governance, executorAddress]) {
    if ((await provider.getCode(account)) !== "0x" || (await provider.getTransactionCount(account)) !== 0 ||
        !(await provider.getBalance(account)).isZero()) throw new Error("Local account collides with historical state");
  }
  const token = new Contract(wrappedNative, TOKEN, provider);
  if (!(await token.balanceOf(owner)).isZero() || !(await token.balanceOf(executorAddress)).isZero())
    throw new Error("Local account already holds historical WETH");
  const vaultBalance = await provider.getBalance(wrappedNative), gasBalance = utils.parseEther("10");
  let executor, deploymentReceipt, tokenState, executorState;
  progress({ stage: "local_deployment", parentBlock: parent.number });
  await provider.send("hardhat_setBalance", [owner, utils.hexValue(gasBalance.add(amount))]);
  await provider.send("hardhat_impersonateAccount", [owner]);
  await provider.send("evm_setAutomine", [false]);
  const sendLocal = async (data, to, value = bn(0)) => {
    const head = await latestBlock(provider);
    const request = { from: owner, data, gas: utils.hexValue(6000000), value: utils.hexValue(value),
      maxFeePerGas: utils.hexValue(bn(head.baseFeePerGas).mul(2).add(1)), maxPriorityFeePerGas: "0x1", type: "0x2" };
    if (to) request.to = to;
    const hash = await provider.send("eth_sendTransaction", [request]);
    await backend.mineBlock({ number: head.number + 1 }, 1);
    const receipt = provider.formatter.receipt(await provider.send("eth_getTransactionReceipt", [hash]));
    if (receipt.status !== 1) throw new Error("Local setup transaction reverted");
    return receipt;
  };
  try {
    const deployment = new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(
      addressesProvider, owner, governance, owner, routers);
    deploymentReceipt = await sendLocal(deployment.data);
    executor = new Contract(deploymentReceipt.contractAddress, artifact.abi, provider);
    if (address(executor.address) !== address(executorAddress) || deploymentReceipt.status !== 1 ||
        !(await executor.executorVersion()).eq(EXECUTOR_VERSION) || !(await executor.executors(owner)) ||
        address(await executor.admin()) !== address(governance) ||
        address(await executor.profitRecipient()) !== address(owner) ||
        address(await executor.lendingPool()) !== address(lendingPool)) throw new Error("Local executor identity mismatch");
    for (const router of routers) if (!(await executor.approvedRouters(router))) throw new Error("Local router approval failed");
    progress({ stage: "local_capital_setup", synthetic: true });
    await sendLocal(token.interface.encodeFunctionData("deposit"), wrappedNative, amount);
    await sendLocal(token.interface.encodeFunctionData("transfer", [executor.address, amount]), wrappedNative);
    if (!(await token.balanceOf(executor.address)).eq(amount) || !(await token.balanceOf(owner)).isZero() ||
        !(await provider.getBalance(wrappedNative)).eq(vaultBalance.add(amount)))
      throw new Error("Synthetic deposit backing mismatch");
    const state = decodeState(await provider.send("anvil_dumpState", []));
    executorState = stateAccount(state, executor.address);
    tokenState = stateAccount(state, wrappedNative);
  } finally {
    if (!backend.miningOutcomeUnknown) {
      await provider.send("hardhat_stopImpersonatingAccount", [owner]);
      await provider.send("evm_setAutomine", [false]);
    }
  }
  // Read actual parent slots after reset. A dump includes read caches, so missing
  // entries must never be assumed to be zero. Standard WETH deposit+transfer of
  // the entire amount changes exactly the new executor's balance mapping slot.
  await originalReset(parent);
  const changed = [];
  for (const [slot, value] of Object.entries(tokenState.storage || {})) {
    const before = await provider.getStorageAt(wrappedNative, slotHex(slot));
    if (!bn(before).eq(value)) changed.push([slot, value, before]);
  }
  if (changed.length !== 1 || !bn(changed[0][2]).isZero() || !bn(changed[0][1]).eq(amount))
    throw new Error("WETH setup changed unexpected historical storage");
  let capitalEnabled = true, capitalAmount = bn(amount);
  const overlay = async () => {
    const capital = capitalEnabled ? capitalAmount : bn(0);
    backend.assertMiningSettled();
    await provider.send("hardhat_setCode", [executor.address, executorState.code]);
    await provider.send("hardhat_setNonce", [executor.address, utils.hexValue(executorState.nonce)]);
    for (const [slot, value] of Object.entries(executorState.storage || {}))
      await provider.send("hardhat_setStorageAt", [executor.address, slotHex(slot), slotHex(value)]);
    await provider.send("hardhat_setBalance", [owner, utils.hexValue(gasBalance)]);
    await provider.send("hardhat_setBalance", [wrappedNative, utils.hexValue(vaultBalance.add(capital))]);
    await provider.send("hardhat_setStorageAt", [wrappedNative, slotHex(changed[0][0]), slotHex(capital)]);
    if ((await latestBlock(provider)).hash !== parent.hash || !(await token.balanceOf(executor.address)).eq(capital) ||
        !(await token.balanceOf(owner)).isZero() || !(await executor.executors(owner)) ||
        address(await executor.lendingPool()) !== address(lendingPool)) throw new Error("Local overlay verification failed");
  };
  // Scope reset interception to this diagnostic instance and one pinned parent.
  backend.reset = async (block, signal) => {
    if (block.hash !== parent.hash) throw new Error("Local executor overlay is pinned to one historical parent");
    await originalReset(block, signal); await overlay();
  };
  try { await overlay(); } catch (error) { backend.reset = originalReset; throw error; }
  return { executor: executor.connect(provider), token, owner, gasBalance, deploymentReceipt,
    runtimeCodeHash: utils.keccak256(executorState.code),
    setFundingMode(mode, selectedAmount = amount) {
      backend.assertMiningSettled();
      if (!["CAPITAL", "FLASH_LOAN"].includes(mode)) throw new Error("Unsupported local funding method");
      const selected = bn(selectedAmount);
      if (selected.lte(0) || selected.gt(amount)) throw new Error("Local capital amount exceeds prepared maximum");
      capitalAmount = selected; capitalEnabled = mode === "CAPITAL";
    }, restoreReset() { backend.reset = originalReset; } };
}

function measureSettlement({ receipt, executor, tokenAddress, recipient, recipientBefore, recipientAfter,
  principalBefore, principalAfter, nativeBefore, nativeAfter, amount, lendingPool, fundingMode, minimumProfit, steps }) {
  if (receipt.status !== 1) throw new Error("Local executor transaction reverted");
  const events = receipt.logs.filter(log => address(log.address) === address(executor.address)).map(log => {
    try { return executor.interface.parseLog(log); } catch (_) { return null; }
  }).filter(Boolean);
  const swaps = events.filter(event => event.name === "SwapExecuted"), withdrawals = events.filter(event => event.name === "ProfitWithdrawn");
  if (withdrawals.length !== 1 || address(withdrawals[0].args.token) !== address(tokenAddress) ||
      address(withdrawals[0].args.recipient) !== address(recipient)) throw new Error("Local profit event mismatch");
  const profit = bn(withdrawals[0].args.amount), increase = bn(recipientAfter).sub(recipientBefore);
  const gasCost = bn(receipt.gasUsed).mul(receipt.effectiveGasPrice);
  if (!increase.eq(profit) || profit.lte(0)) throw new Error("Local receipt profit does not match recipient balance");
  if (!bn(principalBefore).eq(principalAfter)) throw new Error("Local executor principal was consumed");
  if (!bn(nativeBefore).sub(nativeAfter).eq(gasCost)) throw new Error("Local operator gas accounting mismatch");
  if (swaps.length !== steps.length || !bn(swaps[0].args.amountIn).eq(amount) ||
      swaps.some((swap, i) => address(swap.args.tokenIn) !== address(steps[i].tokenIn) ||
        address(swap.args.tokenOut) !== address(steps[i].tokenOut) ||
        (i > 0 && !swap.args.amountIn.eq(swaps[i - 1].args.amountOut))))
    throw new Error("Local swap events do not match route");
  const gross = bn(swaps.at(-1).args.amountOut).sub(amount), flashFee = gross.sub(profit);
  if (flashFee.lt(0) || (fundingMode === "CAPITAL" && !flashFee.isZero()))
    throw new Error("Local funding fee accounting mismatch");
  if (fundingMode === "FLASH_LOAN") {
    const loans = receipt.logs.filter(log => address(log.address) === address(lendingPool)).map(log => {
      try { return AAVE_EVENT.parseLog(log); } catch (_) { return null; }
    }).filter(Boolean);
    if (loans.length !== 1 || address(loans[0].args.target) !== address(executor.address) ||
        address(loans[0].args.initiator) !== address(executor.address) || address(loans[0].args.asset) !== address(tokenAddress) ||
        !loans[0].args.amount.eq(amount) || !loans[0].args.premium.eq(flashFee))
      throw new Error("Local Aave flash-loan receipt mismatch");
  }
  const net = profit.sub(gasCost); // ProfitWithdrawn already excludes flash fee.
  return serialize({ fundingMode, executionSucceeded: true, amountIn: amount,
    grossBeforeFundingFee: profit.add(flashFee), flashloanFee: flashFee, profitWithdrawn: profit,
    recipientBalanceIncrease: increase, principalPreserved: true, startingExecutorWeth: principalBefore,
    syntheticCapital: fundingMode === "CAPITAL", gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice, gasCostNative: gasCost, netAfterGasNative: net,
    netPositive: net.gt(0), meetsConfiguredMinimum: net.gte(minimumProfit) });
}

async function executeLocalMode({ backend, data, endIndex, local, quoteData, fundingMode, minimumProfit, priorityFeeBps = 10000, feeReference, progress = () => {} }) {
  const raw = data.raw.slice(0, endIndex + 1), canonical = data.block.transactions.slice(0, endIndex + 1);
  const provider = backend.provider, { executor, token, owner, gasBalance } = local;
  if (!Number.isSafeInteger(priorityFeeBps) || priorityFeeBps < 0 || priorityFeeBps > 20000)
    throw new Error("Local priority multiplier must be an integer from 0 to 20000 bps");
  local.setFundingMode(fundingMode, quoteData.borrowAmount);
  progress({ stage: "executor_prefix", fundingMode, blockNumber: data.block.number, endIndex });
  await backend.reset(data.parent);
  const prefix = await backend.mine(raw, data.block, { canonicalTransactions: canonical });
  verifyReceipts(prefix.receipts, data.receipts.slice(0, endIndex + 1));
  const principal = await token.balanceOf(executor.address), recipient = await token.balanceOf(owner);
  const lendingPool = await executor.lendingPool();
  const historicalReceipt = feeReference || data.receipts[endIndex + 1];
  if (!historicalReceipt?.effectiveGasPrice) throw new Error("Historical fee evidence missing");
  const historicalPriority = bn(historicalReceipt.effectiveGasPrice).sub(data.block.baseFeePerGas);
  if (historicalPriority.lt(0)) throw new Error("Historical arbitrage priority fee is negative");
  const priority = historicalPriority.mul(priorityFeeBps).div(10000), effectiveGasPrice = bn(data.block.baseFeePerGas).add(priority);
  const transaction = { from: owner, to: executor.address,
    data: executor.interface.encodeFunctionData(fundingMode === "CAPITAL" ? "executeCapitalArbitrage" : "initiateFlashLoan", [quoteData]),
    gasLimit: 1500000, maxFeePerGas: bn(data.block.baseFeePerGas).add(priority), maxPriorityFeePerGas: priority };
  progress({ stage: "executor_bundle", fundingMode, blockNumber: data.block.number, endIndex });
  const sim = await backend.simulateUnsignedPrefix({ rawTransactions: raw, canonicalTransactions: canonical,
    parent: data.parent, header: data.block, transaction });
  verifyReceipts(sim.prefixReceipts, data.receipts.slice(0, endIndex + 1));
  if (sim.backrunReceipt.transactionIndex !== endIndex + 1 || sim.backrunReceipt.blockNumber !== data.block.number ||
      !bn(sim.backrunReceipt.effectiveGasPrice).eq(effectiveGasPrice))
    throw new Error("Local executor index/block/gas price mismatch");
  const settlement = measureSettlement({ receipt: sim.backrunReceipt, executor, tokenAddress: quoteData.borrowToken,
    recipient: owner, recipientBefore: recipient, recipientAfter: await token.balanceOf(owner),
    principalBefore: principal, principalAfter: await token.balanceOf(executor.address),
    nativeBefore: gasBalance, nativeAfter: await provider.getBalance(owner), amount: quoteData.borrowAmount,
    lendingPool, fundingMode, minimumProfit, steps: quoteData.steps });
  for (const step of quoteData.steps)
    if (!(await new Contract(step.tokenIn, TOKEN, provider).allowance(executor.address, step.router)).isZero())
      throw new Error("Local router allowance was not cleared");
  if (!(await token.allowance(executor.address, await executor.lendingPool())).isZero())
    throw new Error("Local Aave repayment allowance was not consumed");
  // Ensure rebuilding the prefix did not change its logs, in addition to its gas.
  return { ...settlement, txHash: sim.backrunHash, transactionIndex: sim.backrunReceipt.transactionIndex,
    sameBlock: sim.targetBlock === data.block.number, unsigned: true, mainnetSubmitted: false,
    canonicalReceiptsVerified: true, routerAllowancesCleared: true, aaveAllowanceCleared: true,
    directCoinbasePayment: sim.directCoinbasePayment,
    priorityFeeBps, feeReferenceSource: feeReference?.source || "next_canonical_transaction",
    historicalPriorityFeePerGas: historicalPriority.toString(),
    priorityFeePerGas: priority.toString(), builderPriorityPaymentNative: priority.mul(sim.gasUsed).toString(),
    feeAssumption: priorityFeeBps === 10000 ? (feeReference ?
      "stated historical fee reference; no additional direct builder payment modelled; inclusion not tested" :
      "historical arbitrage effective gas price; no additional direct builder payment modelled") :
      "hypothetical priority multiplier; unchanged historical base fee; inclusion not tested",
    inclusionTested: false };
}
module.exports = { prepareLocalExecutor, executeLocalMode, measureSettlement, decodeState };
