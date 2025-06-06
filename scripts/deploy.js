// scripts/deploy.js

/**
 * Full Hardhat deployment script for the Flashloan Arbitrage project.
 *
 * This script deploys:
 *   1. ArbitrageFlashloan (flashloan receiver and arbitrage executor)
 *   2. ArbitrageTimelock (governance timelock controller)
 *   3. ConnextAdapter (cross‐chain profit forwarding via Connext)
 *
 * It reads all necessary constructor parameters from .env, applies optional EIP-1559 gas overrides,
 * and verifies each contract on Etherscan if ETHERSCAN_API_KEY is set.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network <network>
 */

require("dotenv").config();
const hre = require("hardhat");
const { ethers, network, run } = hre;

async function main() {
  // ─── Environment variables ─────────────────────────────────────────────────
  const {
    PRIVATE_KEY,
    ETHERSCAN_API_KEY,

    // ArbitrageFlashloan parameters
    AAVE_LENDING_POOL_ADDRESS_PROVIDER,
    MAX_LOSS_BPS, // e.g. "50"  (0.50%)
    FLASHLOAN_PREMIUM_BIPS, // e.g. "9"   (0.09%)

    // Timelock parameters
    TIMELOCK_MIN_DELAY_SEC, // e.g. "86400" for 24h delay
    TIMELOCK_PROPOSERS, // comma-separated list of proposer addresses
    TIMELOCK_EXECUTORS, // comma-separated list of executor addresses

    // ConnextAdapter parameters
    CONNEXT_ADDRESS, // Connext contract address on this network
    DESTINATION_DOMAIN, // numeric domain ID for Connext
    RECIPIENT_ON_DESTINATION, // address on destination chain that receives forwarded funds

    // Optional EIP-1559 gas overrides (in gwei)
    GAS_PRICE_CEILING, // e.g. "30"
    MAX_PRIORITY_FEE, // e.g. "2"
  } = process.env;

  // ─── Validate required variables ─────────────────────────────────────────────
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY is not set in .env");
    process.exit(1);
  }
  if (!AAVE_LENDING_POOL_ADDRESS_PROVIDER) {
    console.error(
      "Error: AAVE_LENDING_POOL_ADDRESS_PROVIDER is not set in .env"
    );
    process.exit(1);
  }
  if (!MAX_LOSS_BPS) {
    console.error("Error: MAX_LOSS_BPS is not set in .env");
    process.exit(1);
  }
  if (!FLASHLOAN_PREMIUM_BIPS) {
    console.error("Error: FLASHLOAN_PREMIUM_BIPS is not set in .env");
    process.exit(1);
  }
  if (!TIMELOCK_MIN_DELAY_SEC) {
    console.error("Error: TIMELOCK_MIN_DELAY_SEC is not set in .env");
    process.exit(1);
  }
  if (!TIMELOCK_PROPOSERS) {
    console.error("Error: TIMELOCK_PROPOSERS is not set in .env");
    process.exit(1);
  }
  if (!TIMELOCK_EXECUTORS) {
    console.error("Error: TIMELOCK_EXECUTORS is not set in .env");
    process.exit(1);
  }
  if (!CONNEXT_ADDRESS) {
    console.error("Error: CONNEXT_ADDRESS is not set in .env");
    process.exit(1);
  }
  if (!DESTINATION_DOMAIN) {
    console.error("Error: DESTINATION_DOMAIN is not set in .env");
    process.exit(1);
  }
  if (!RECIPIENT_ON_DESTINATION) {
    console.error("Error: RECIPIENT_ON_DESTINATION is not set in .env");
    process.exit(1);
  }

  console.log(
    `\n📡  Network: ${network.name} (chainId: ${network.config.chainId})`
  );
  const provider = ethers.provider;
  const deployer = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`🔑  Deployer address: ${deployer.address}\n`);

  // ─── Verify existence of external contracts ─────────────────────────────────
  const externalChecks = [
    ["Aave Provider", AAVE_LENDING_POOL_ADDRESS_PROVIDER],
    ["Connext", CONNEXT_ADDRESS],
  ];
  for (const [label, addr] of externalChecks) {
    const code = await provider.getCode(addr);
    if (code === "0x") {
      console.error(
        `Error: ${label} has no contract at ${addr} on ${network.name}`
      );
      process.exit(1);
    }
    console.log(`✔  ${label} found at ${addr}`);
  }
  console.log();

  // ─── Compile contracts ──────────────────────────────────────────────────────
  console.log("🔨  Compiling contracts...");
  await run("compile");
  console.log();

  // ─── EIP-1559 Gas Overrides ─────────────────────────────────────────────────
  const feeData = await provider.getFeeData();
  const maxFeePerGas = GAS_PRICE_CEILING
    ? ethers.utils.parseUnits(GAS_PRICE_CEILING, "gwei")
    : feeData.maxFeePerGas;
  const maxPriorityFeePerGas = MAX_PRIORITY_FEE
    ? ethers.utils.parseUnits(MAX_PRIORITY_FEE, "gwei")
    : feeData.maxPriorityFeePerGas;

  console.log(
    `Using maxFeePerGas: ${ethers.utils.formatUnits(
      maxFeePerGas,
      "gwei"
    )} gwei, ` +
      `maxPriorityFeePerGas: ${ethers.utils.formatUnits(
        maxPriorityFeePerGas,
        "gwei"
      )} gwei`
  );
  console.log();

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Deploy ArbitrageFlashloan
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("🚀  Deploying ArbitrageFlashloan...");
  const ArbFactory = await ethers.getContractFactory(
    "ArbitrageFlashloan",
    deployer
  );
  const arbitrage = await ArbFactory.deploy(
    AAVE_LENDING_POOL_ADDRESS_PROVIDER,
    parseInt(MAX_LOSS_BPS, 10),
    parseInt(FLASHLOAN_PREMIUM_BIPS, 10),
    {
      maxFeePerGas,
      maxPriorityFeePerGas,
    }
  );
  await arbitrage.deployed();
  console.log(`✅  ArbitrageFlashloan deployed at: ${arbitrage.address}\n`);

  // ─── Verify ArbitrageFlashloan on Etherscan ─────────────────────────────────
  if (ETHERSCAN_API_KEY) {
    console.log("🔍  Verifying ArbitrageFlashloan on Etherscan...");
    try {
      await run("verify:verify", {
        address: arbitrage.address,
        constructorArguments: [
          AAVE_LENDING_POOL_ADDRESS_PROVIDER,
          parseInt(MAX_LOSS_BPS, 10),
          parseInt(FLASHLOAN_PREMIUM_BIPS, 10),
        ],
      });
      console.log("✅  Verification of ArbitrageFlashloan succeeded!\n");
    } catch (e) {
      console.warn("⚠  Verification of ArbitrageFlashloan failed:", e.message);
      console.log(
        `    To verify manually:\n` +
          `      npx hardhat verify --network ${network.name} ${arbitrage.address} ` +
          `${AAVE_LENDING_POOL_ADDRESS_PROVIDER} ${MAX_LOSS_BPS} ${FLASHLOAN_PREMIUM_BIPS}\n`
      );
    }
  } else {
    console.log(
      "⚠  No ETHERSCAN_API_KEY set; skipping ArbitrageFlashloan verification.\n"
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Deploy ArbitrageTimelock
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("🚀  Deploying ArbitrageTimelock...");
  const TimelockFactory = await ethers.getContractFactory(
    "ArbitrageTimelock",
    deployer
  );
  const proposers = TIMELOCK_PROPOSERS.split(",").map((addr) => addr.trim());
  const executors = TIMELOCK_EXECUTORS.split(",").map((addr) => addr.trim());
  const minDelayNs = ethers.BigNumber.from(TIMELOCK_MIN_DELAY_SEC);

  // NOTE: OZ TimelockController constructor: (uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
  const timelock = await TimelockFactory.deploy(
    minDelayNs,
    proposers,
    executors,
    deployer.address,
    {
      maxFeePerGas,
      maxPriorityFeePerGas,
    }
  );
  await timelock.deployed();
  console.log(`✅  ArbitrageTimelock deployed at: ${timelock.address}\n`);

  // Transfer ownership of ArbitrageFlashloan to the Timelock
  console.log(
    "🔐  Transferring ownership of ArbitrageFlashloan to Timelock..."
  );
  await arbitrage.transferOwnership(timelock.address);
  console.log(
    `✅  Ownership of ArbitrageFlashloan transferred to: ${timelock.address}\n`
  );

  // ─── Verify ArbitrageTimelock on Etherscan ──────────────────────────────────
  if (ETHERSCAN_API_KEY) {
    console.log("🔍  Verifying ArbitrageTimelock on Etherscan...");
    try {
      await run("verify:verify", {
        address: timelock.address,
        constructorArguments: [
          minDelayNs,
          proposers,
          executors,
          deployer.address,
        ],
      });
      console.log("✅  Verification of ArbitrageTimelock succeeded!\n");
    } catch (e) {
      console.warn("⚠  Verification of ArbitrageTimelock failed:", e.message);
      console.log(
        `    To verify manually:\n` +
          `      npx hardhat verify --network ${network.name} ${timelock.address} ` +
          `${TIMELOCK_MIN_DELAY_SEC} ["${proposers.join(
            '","'
          )}"] ["${executors.join('","')}"] ${deployer.address}\n`
      );
    }
  } else {
    console.log(
      "⚠  No ETHERSCAN_API_KEY set; skipping ArbitrageTimelock verification.\n"
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Deploy ConnextAdapter
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("🚀  Deploying ConnextAdapter...");
  const ConnextFactory = await ethers.getContractFactory(
    "ConnextAdapter",
    deployer
  );
  const connextAdapter = await ConnextFactory.deploy(
    CONNEXT_ADDRESS,
    parseInt(DESTINATION_DOMAIN, 10),
    RECIPIENT_ON_DESTINATION,
    {
      maxFeePerGas,
      maxPriorityFeePerGas,
    }
  );
  await connextAdapter.deployed();
  console.log(`✅  ConnextAdapter deployed at: ${connextAdapter.address}\n`);

  // ─── Verify ConnextAdapter on Etherscan ─────────────────────────────────────
  if (ETHERSCAN_API_KEY) {
    console.log("🔍  Verifying ConnextAdapter on Etherscan...");
    try {
      await run("verify:verify", {
        address: connextAdapter.address,
        constructorArguments: [
          CONNEXT_ADDRESS,
          parseInt(DESTINATION_DOMAIN, 10),
          RECIPIENT_ON_DESTINATION,
        ],
      });
      console.log("✅  Verification of ConnextAdapter succeeded!\n");
    } catch (e) {
      console.warn("⚠  Verification of ConnextAdapter failed:", e.message);
      console.log(
        `    To verify manually:\n` +
          `      npx hardhat verify --network ${network.name} ${connextAdapter.address} ` +
          `${CONNEXT_ADDRESS} ${DESTINATION_DOMAIN} ${RECIPIENT_ON_DESTINATION}\n`
      );
    }
  } else {
    console.log(
      "⚠  No ETHERSCAN_API_KEY set; skipping ConnextAdapter verification.\n"
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Deployment Summary
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("──────────────────────────────────────────────────────");
  console.log(" 🎉 Deployment complete! Summary of addresses:");
  console.log(`   • ArbitrageFlashloan:  ${arbitrage.address}`);
  console.log(`   • ArbitrageTimelock:   ${timelock.address}`);
  console.log(`   • ConnextAdapter:      ${connextAdapter.address}`);
  console.log("──────────────────────────────────────────────────────\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌  Deployment failed:", err);
    process.exit(1);
  });
