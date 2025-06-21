// server/scripts/approve.js
/**
 * Grants ERC-20 allowances for Uniswap & SushiSwap routers.
 * Pattern: reset allowance → approve 2¹²⁸−1, not MaxUint256.
 * Fallback: if token reverts “exceeds 96 bits,” retry with 2⁹⁶−1.
 *
 * Usage:
 *   npx hardhat run server/scripts/approve.js --network localhost
 */

require("dotenv").config();
const hre = require("hardhat");
const { ethers, network } = hre;

async function main() {
  const {
    PRIVATE_KEY,

    // Token addresses (set in your .env)
    TOKENS_DAI,
    TOKENS_WETH,
    TOKENS_USDC,
    TOKENS_WBTC,
    TOKENS_LINK,
    TOKENS_USDT,
    TOKENS_BUSD,
    TOKENS_UNI,
    TOKENS_AAVE,

    // Router addresses
    UNISWAP_ROUTER_ADDRESS,
    SUSHISWAP_ROUTER_ADDRESS,
  } = process.env;

  if (!PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY in .env");
  }

  console.log(
    `\n📡  Network: ${network.name} (chainId: ${network.config.chainId})`
  );
  const provider = ethers.provider;
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`🔑  Using wallet: ${wallet.address}\n`);

  // Map of symbol → token address
  const TOKENS = {
    DAI: TOKENS_DAI,
    WETH: TOKENS_WETH,
    USDC: TOKENS_USDC,
    WBTC: TOKENS_WBTC,
    LINK: TOKENS_LINK,
    USDT: TOKENS_USDT,
    BUSD: TOKENS_BUSD,
    UNI: TOKENS_UNI,
    AAVE: TOKENS_AAVE,
  };

  // Minimal ERC-20 ABI for allowance/approve
  const ERC20_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];

  // Default target: 2^128−1
  const TARGET_ALLOWANCE = ethers.BigNumber.from(
    "0xffffffffffffffffffffffffffffffff"
  );
  // Fallback for 96-bit-capped tokens: 2^96−1
  const MAX_ALLOWANCE_96 = ethers.BigNumber.from(2).pow(96).sub(1);

  for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {
    if (!tokenAddress || tokenAddress === ethers.constants.AddressZero) {
      console.log(`⏭  Skipping ${symbol}: no address configured`);
      continue;
    }

    // Skip if no contract at that address
    const code = await provider.getCode(tokenAddress);
    if (code === "0x") {
      console.log(
        `⏭  Skipping ${symbol}: no contract found at ${tokenAddress}`
      );
      continue;
    }

    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

    for (const router of ROUTERS) {
      try {
        // Skip router if not deployed here
        const rCode = await provider.getCode(router);
        if (rCode === "0x") {
          console.log(
            `⏭  Skipping router ${router}: not deployed on ${network.name}`
          );
          continue;
        }

        const current = await token.allowance(wallet.address, router);
        console.log(`${symbol} allowance to ${router}: ${current.toString()}`);

        if (current.gte(TARGET_ALLOWANCE)) {
          console.log(`✔  ${symbol} → ${router} already sufficient\n`);
          continue;
        }

        // 1) Reset to zero
        console.log(`↺  Resetting ${symbol} allowance → 0 for ${router}`);
        await (await token.approve(router, 0)).wait();

        // 2) Attempt 2^128−1
        console.log(
          `➡  Approving ${symbol} → ${router} (${TARGET_ALLOWANCE.toString()})`
        );
        try {
          const tx = await token.approve(router, TARGET_ALLOWANCE, {
            gasLimit: 100_000,
          });
          await tx.wait();
          console.log(`✅  Approved ${symbol} → ${router} (tx: ${tx.hash})\n`);
        } catch (err) {
          const reason = err.reason || err.message || "";
          if (reason.includes("exceeds 96 bits")) {
            // Fallback for 96-bit restricted tokens
            console.log(
              `⚠  ${symbol} approval too large, retrying with 96-bit max (${MAX_ALLOWANCE_96.toString()})`
            );
            const tx2 = await token.approve(router, MAX_ALLOWANCE_96, {
              gasLimit: 100_000,
            });
            await tx2.wait();
            console.log(
              `✅  Approved ${symbol} → ${router} at 96-bit max (tx: ${tx2.hash})\n`
            );
          } else {
            throw err;
          }
        }
      } catch (err) {
        console.warn(
          `⚠  Error processing ${symbol} → ${router}: ${
            err.reason || err.message
          }`
        );
      }
    }
  }

  console.log("🎉  All token approvals complete\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n❌  Approval script failed:\n${err.stack}`);
    process.exit(1);
  });
