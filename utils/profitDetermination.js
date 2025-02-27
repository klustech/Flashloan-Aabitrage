// profitDetermination.js
const { ethers } = require("ethers");
const axios = require("axios");

// ----- Configuration Parameters -----
// These values can come from environment variables or a config file.
const configParams = {
  // For simulation, assume 1 ETH = 2000 DAI.
  ethToDaiRate: 2000,
  // Slippage tolerance (e.g., 0.5% = 0.005)
  slippageTolerance: 0.005,
  // Maximum acceptable gas price (in gwei) – not strictly used in simulation here,
  // but could be enforced before execution.
  gasPriceLimit: ethers.utils.parseUnits("50", "gwei"),
  // Trade size for simulation (in DAI)
  tradeSize: 1000000,
  // Flashloan premium in basis points (1 bip = 0.01%); here, 9 bips = 0.09%
  flashloanPremiumBips: 9,
};

// ----- Helper Functions -----

// Get live gas price using ethers provider (returns a BigNumber in wei)
async function getLiveGasPrice(provider) {
  try {
    const gasPrice = await provider.getGasPrice();
    console.log(`Live Gas Price: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei`);
    return gasPrice;
  } catch (error) {
    console.error("Error fetching live gas price:", error);
    // Fallback to a default (e.g. 50 gwei)
    return ethers.utils.parseUnits("50", "gwei");
  }
}

// Estimate gas cost in ETH using gasUsed (BigNumber) and gasPrice (BigNumber)
function estimateGasCostETH(gasUsed, gasPrice) {
  // Multiply and format to ETH (as a float)
  return parseFloat(ethers.utils.formatEther(gasUsed.mul(gasPrice)));
}

// Convert ETH to DAI using an assumed conversion rate
function convertEthToDai(amountETH, ethToDaiRate) {
  return amountETH * ethToDaiRate;
}

// Apply a flashloan premium to a given amount
function applyFlashloanPremium(amount, premiumBips) {
  const multiplier = 1 + premiumBips / 10000; // e.g., 9 bips => 1 + 9/10000 = 1.0009
  return amount * multiplier;
}

// ----- Route Simulation -----
// For simplicity, a route is defined as a series of swap steps.
// Each step is represented by a simulation function that takes an input amount and returns an output amount.
function simulateRoute(route, inputAmount) {
  let output = inputAmount;
  for (let i = 0; i < route.steps.length; i++) {
    const step = route.steps[i];
    output = step.simulate(output);
    console.log(`  After step ${i + 1} (${step.description}): ${output.toFixed(6)}`);
  }
  return output;
}

// ----- Main Profit Determination Function -----
// Given a route, input amount (in DAI), and gas usage (as a BigNumber), this function calculates:
// - simulated output (in DAI) after executing all swap steps
// - estimated gas cost (in DAI)
// - total cost including flashloan premium and gas cost
// - net profit (simulated output minus total cost)
async function determineProfit(provider, route, inputAmount, gasUsed, flashloanPremiumBips, configParams) {
  // Get live gas price (wei)
  const gasPrice = await getLiveGasPrice(provider);

  // Check that gasPrice is under your configured gas price limit (if desired)
  if (gasPrice.gt(configParams.gasPriceLimit)) {
    console.warn("Gas price exceeds configured limit; aborting simulation.");
    return null;
  }

  // Estimate gas cost in ETH
  const gasCostETH = estimateGasCostETH(gasUsed, gasPrice);
  // Convert gas cost to DAI using the assumed ETH-to-DAI rate
  const gasCostDAI = convertEthToDai(gasCostETH, configParams.ethToDaiRate);
  console.log(`Estimated Gas Cost: ${gasCostETH} ETH ~ ${gasCostDAI.toFixed(6)} DAI`);

  // Run simulation for the route
  const simulatedOutput = simulateRoute(route, inputAmount);
  console.log(`Simulated Output from route '${route.name}': ${simulatedOutput.toFixed(6)} DAI`);

  // Total cost includes the input trade size plus gas cost
  let totalCostDAI = inputAmount + gasCostDAI;
  // Apply flashloan premium on the borrowed amount
  totalCostDAI = applyFlashloanPremium(totalCostDAI, flashloanPremiumBips);
  console.log(`Total Cost after Flashloan Premium: ${totalCostDAI.toFixed(6)} DAI`);

  // Net profit calculation
  const profit = simulatedOutput - totalCostDAI;
  return {
    simulatedOutput,
    gasCostDAI,
    totalCostDAI,
    profit,
  };
}

// ----- Example Usage -----
// This example simulates one route: DAI → WETH → DAI on Uniswap.
// In a real bot, you would define many such routes, each with its own swap simulation logic.
async function runProfitDetermination() {
  // Set up ethers provider (using Infura; replace with your API key)
  const provider = new ethers.providers.InfuraProvider("mainnet", process.env.INFURA_API_KEY || "your_infura_key_here");

  // Define the route: each step applies a simple conversion with a slippage factor.
  const route = {
    name: "DAI → WETH → DAI (Uniswap)",
    steps: [
      {
        description: "DAI to WETH",
        simulate: (amount) => {
          // Convert DAI to WETH using the rate (1 ETH = 2000 DAI)
          let wethAmount = amount / configParams.ethToDaiRate;
          // Apply slippage (reduce output by slippage tolerance)
          return wethAmount * (1 - configParams.slippageTolerance);
        },
      },
      {
        description: "WETH to DAI",
        simulate: (amount) => {
          // Convert WETH back to DAI using the same rate
          let daiAmount = amount * configParams.ethToDaiRate;
          return daiAmount * (1 - configParams.slippageTolerance);
        },
      },
    ],
  };

  // For simulation, assume a gas usage (this value might come from prior estimations)
  const gasUsed = ethers.BigNumber.from("200000");

  // Run profit determination
  const result = await determineProfit(
    provider,
    route,
    configParams.tradeSize,
    gasUsed,
    configParams.flashloanPremiumBips,
    configParams
  );

  if (result) {
    console.log("\n=== Profit Determination Result ===");
    console.log(`Simulated Output: ${result.simulatedOutput.toFixed(6)} DAI`);
    console.log(`Estimated Gas Cost: ${result.gasCostDAI.toFixed(6)} DAI`);
    console.log(`Total Cost (with premium): ${result.totalCostDAI.toFixed(6)} DAI`);
    console.log(`Net Profit: ${result.profit.toFixed(6)} DAI`);
    if (result.profit > 0) {
      console.log("Arbitrage opportunity found!");
      // In your bot, you would now trigger trade execution here.
    } else {
      console.log("No profitable arbitrage opportunity at this time.");
    }
  } else {
    console.log("Simulation aborted due to high gas price.");
  }
}

// If running this module directly, execute the simulation.
if (require.main === module) {
  runProfitDetermination().catch(console.error);
}

// Export the determineProfit function for integration with your bot
module.exports = {
  determineProfit,
};
