// server/scripts/approve.js
//
// Grants ERC-20 allowances for Uniswap & SushiSwap routers.
// Safer pattern: reset allowance → approve 2¹²⁸-1 (≈3.4 e38), *not* MaxUint256.

require("dotenv").config();
const { ethers } = require("ethers");

/* ────────────────────────────────────
   Environment
   ────────────────────────────────────*/
const {
  PRIVATE_KEY,
  MAINNET_RPC_URL,
  SEPOLIA_RPC_URL,

  // token addresses (DAI, WETH, …) – same names you already use
  TOKENS_DAI,
  TOKENS_WETH,
  TOKENS_USDC,
  TOKENS_WBTC,
  TOKENS_LINK,
  TOKENS_USDT,
  TOKENS_BUSD,
  TOKENS_UNI,
  TOKENS_AAVE,

  // router addresses
  UNISWAP_ROUTER_ADDRESS,
  SUSHISWAP_ROUTER_ADDRESS,
} = process.env;

const RPC_URL = MAINNET_RPC_URL || SEPOLIA_RPC_URL;
if (!RPC_URL)
  throw new Error(
    "❌  No RPC URL provided (MAINNET_RPC_URL / SEPOLIA_RPC_URL)"
  );

/* ────────────────────────────────────
   Provider & wallet
   ────────────────────────────────────*/
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
console.log(`🔑  Using wallet: ${wallet.address}`);

/* ────────────────────────────────────
   Tokens / Routers
   ────────────────────────────────────*/
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
const ROUTERS = [UNISWAP_ROUTER_ADDRESS, SUSHISWAP_ROUTER_ADDRESS];

/* ────────────────────────────────────
   Minimal ERC-20 ABI
   ────────────────────────────────────*/
const ERC20_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

/* ────────────────────────────────────
   Helpers
   ────────────────────────────────────*/
const TARGET_ALLOWANCE = ethers.BigNumber.from(
  "0xffffffffffffffffffffffffffffffff"
); // 2^128-1

async function approveToken(tokenAddr, spender) {
  if (!tokenAddr || tokenAddr === ethers.constants.AddressZero) return;

  const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const current = await token.allowance(wallet.address, spender);

  if (current.gte(TARGET_ALLOWANCE)) {
    console.log(`✔  Allowance already sufficient → ${tokenAddr} → ${spender}`);
    return;
  }

  // reset, then set
  console.log(`↺  Resetting allowance for ${tokenAddr} → ${spender}`);
  await (await token.approve(spender, 0)).wait();

  console.log(`➡  Approving ${tokenAddr} → ${spender} (2^128-1)`);
  const tx = await token.approve(spender, TARGET_ALLOWANCE, {
    gasLimit: ethers.utils.hexlify(100_000),
  });
  await tx.wait();
  console.log(`✅  Approved (tx: ${tx.hash})`);
}

/* ────────────────────────────────────
   Main
   ────────────────────────────────────*/
async function main() {
  const bal = await wallet.getBalance();
  if (bal.lt(ethers.utils.parseEther("0.01")))
    throw new Error("Fund wallet with ≥0.01 ETH for gas");

  for (const [sym, addr] of Object.entries(TOKENS)) {
    if (!addr) continue;
    for (const router of ROUTERS) {
      await approveToken(addr, router);
    }
  }
  console.log("🎉  All token approvals complete");
}

main().catch((err) => {
  console.error("❌  Approval script failed:", err);
  process.exit(1);
});
