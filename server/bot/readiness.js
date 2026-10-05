const fs = require("fs");
const { Contract, utils } = require("ethers");
const { address } = require("./units");
const { EXECUTOR_VERSION } = require("../config/executorVersion");
async function startupChecks({
  provider,
  contract,
  profile,
  operatorAddress,
  requireSignerGas = true,
}) {
  const errors = [],
    checks = [];
  const check = async (label, fn) => {
    try {
      await fn();
      checks.push({ name: label, passed: true });
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      checks.push({ name: label, passed: false });
    }
  };
  await check("chain", async () => {
    if ((await provider.getNetwork()).chainId !== profile.chainId)
      throw new Error("chain ID mismatch");
  });
  await check("contract", async () => {
    const code = await provider.getCode(contract.address);
    if (code === "0x") throw new Error("no executor bytecode");
    if (
      !profile.expectedContractCodeHash ||
      utils.keccak256(code) !== profile.expectedContractCodeHash
    )
      throw new Error("EXPECTED_CONTRACT_CODE_HASH missing/mismatched");
    // Readiness also checks v4-only roles; any other version is not operable.
    const version=Number((await contract.executorVersion()).toString());
    if (version !== EXECUTOR_VERSION)
      throw new Error(`executor version ${EXECUTOR_VERSION} required (found ${version})`);
  });
  if (requireSignerGas)
    await check("signer gas", async () => {
      const required = utils
        .parseUnits(profile.gasCeilingGwei, "gwei")
        .mul(profile.maxGasUnits);
      if ((await provider.getBalance(operatorAddress)).lt(required))
        throw new Error("insufficient ETH for maximum trade gas");
    });
  await check("executor role", async () => {
    if (!operatorAddress || !(await contract.executors(operatorAddress)))
      throw new Error("operator lacks the executor role");
  });
  await check("governance", async () => {
    const admin = address(await contract.admin());
    if (!profile.expectedAdmin || admin !== address(profile.expectedAdmin))
      throw new Error("EXPECTED_ADMIN missing/mismatched");
    if (operatorAddress && admin === address(operatorAddress))
      throw new Error("hot operator must not be the executor admin");
    // An EOA admin has no delay and no co-signers; require a contract
    // (timelock controlled by a multisig).
    if ((await provider.getCode(admin)) === "0x")
      throw new Error("executor admin must be a timelock/multisig contract");
  });
  await check("recipient", async () => {
    const recipient = address(await contract.profitRecipient());
    if (
      !profile.expectedProfitRecipient ||
      recipient !== address(profile.expectedProfitRecipient)
    )
      throw new Error("EXPECTED_PROFIT_RECIPIENT missing/mismatched");
    if (operatorAddress && recipient === address(operatorAddress))
      throw new Error("profit recipient must not be the hot operator");
  });
  await check("routers", async () => {
    for (const [dex, config] of Object.entries(profile.routers || {}))
      if (!config.router || !(await contract.approvedRouters(config.router)))
        throw new Error(`${dex} router not approved on-chain`);
  });
  await check("pause", async () => {
    if (await contract.paused()) throw new Error("contract paused");
  });
  await check("aave", async () => {
    if (
      address(await contract.provider()) !==
        address(profile.flashloanProvider.addressesProvider) ||
      address(await contract.lendingPool()) !==
        address(profile.flashloanProvider.lendingPool)
    )
      throw new Error("Aave V2 mismatch");
    const c = new Contract(
      address(profile.flashloanProvider.addressesProvider),
      ["function getLendingPool() view returns(address)"],
      provider
    );
    if (
      address(await c.getLendingPool()) !==
      address(profile.flashloanProvider.lendingPool)
    )
      throw new Error("Aave provider changed");
  });
  for (const [dex, config] of Object.entries(profile.routers))
    await check(dex, async () => {
      for (const addr of [config.router, config.factory, config.quoter].filter(
        Boolean
      ))
        if ((await provider.getCode(address(addr))) === "0x")
          throw new Error("missing adapter bytecode");
      const r = new Contract(
        address(config.router),
        ["function factory() view returns(address)"],
        provider
      );
      if (address(await r.factory()) !== address(config.factory))
        throw new Error("router factory mismatch");
    });
  return {
    ready: errors.length === 0,
    errors,
    checks,
    checkedAt: Date.now(),
    profileFingerprint: profile.fingerprint,
  };
}
function commissioningChecks(profile, env = process.env) {
  const errors = [];
  let evidence = null;
  try {
    evidence = JSON.parse(
      fs.readFileSync(
        env.COMMISSIONING_EVIDENCE_PATH || "runtime/commissioning.json",
        "utf8"
      )
    );
    if (evidence.profileFingerprint !== profile.fingerprint)
      throw new Error("evidence configuration mismatch");
    if (
      !evidence.forkProof?.passed ||
      !evidence.forkProof.blockNumber ||
      !evidence.forkProof.txHash
    )
      throw new Error("real mainnet-fork proof missing");
    if (
      !evidence.paperBurnIn?.passed ||
      evidence.paperBurnIn.continuousMs < 7 * 86400000 ||
      evidence.paperBurnIn.simulated < 1
    )
      throw new Error("seven-day paper burn-in incomplete");
  } catch (err) {
    errors.push(err.message);
  }
  if (!env.PRIVATE_KEY) errors.push("PRIVATE_KEY is required for LIVE");
  return { ready: errors.length === 0, errors, evidence };
}
module.exports = { startupChecks, commissioningChecks };
