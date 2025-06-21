// server/scripts/balancerUtils.js

const { BalancerSDK, Network } = require("@balancer-labs/sdk");
const { ethers } = require("ethers");

const RPC_URL = process.env.ETH_RPC_URL;
const CHAIN_ID = Network.MAINNET; // use BalancerSDK.Network.MAINNET

// Initialize Balancer SDK; this also sets up an SOR instance internally
const balancer = new BalancerSDK({ network: CHAIN_ID, rpcUrl: RPC_URL });

// Extract the SOR instance provided by BalancerSDK
const sor = balancer.sor;

async function getBalancerQuote(tokenIn, tokenOut, amountIn) {
  const swapInfo = await sor.getSwaps({
    tokenIn,
    tokenOut,
    swapType: 0, // 0 = SwapExactIn
    amount: amountIn.toString(),
  });
  return ethers.BigNumber.from(swapInfo.returnAmount);
}

module.exports = { balancer, sor, getBalancerQuote };
