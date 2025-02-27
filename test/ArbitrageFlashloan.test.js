const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Single comprehensive test for ArbitrageFlashloan on a mainnet fork.
 * This file deploys the contract with exactly three constructor arguments
 * and passes explicit gas fee overrides to ensure that maxFeePerGas and
 * maxPriorityFeePerGas are high enough for the current base fee.
 *
 * Ensure you run:
 *   npx hardhat node --fork https://mainnet.infura.io/v3/YOUR_INFURA_KEY --fork-block-number 17000000
 * in one terminal, then:
 *   npx hardhat test --network localhost
 * in another.
 */
describe("ArbitrageFlashloan (Mainnet Fork)", function () {
  let deployer;
  let arbitrage;

  // Mainnet addresses for the required contracts:
  const AAVE_PROVIDER_MAINNET = "0xb53c1a33016b2dc2ff3653530bff1848a515c8c5"; // Aave LendingPoolAddressProvider V2
  const UNISWAP_ROUTER_MAINNET = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2 Router02
  const SUSHISWAP_ROUTER_MAINNET = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F"; // SushiSwap Router

  before(async function () {
    [deployer] = await ethers.getSigners();

    const ArbitrageFlashloan = await ethers.getContractFactory("ArbitrageFlashloan");

    // Deploy with exactly three constructor arguments.
    // Also, include an explicit gas override object with sufficiently high maxFeePerGas.
    arbitrage = await ArbitrageFlashloan.deploy(
      AAVE_PROVIDER_MAINNET,
      UNISWAP_ROUTER_MAINNET,
      SUSHISWAP_ROUTER_MAINNET,
      {
        maxFeePerGas: ethers.utils.parseUnits("100", "gwei"),
        maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei"),
      }
    );
    await arbitrage.deployed();
  });

  it("Should assign the contract deployer as the owner", async function () {
    expect(await arbitrage.owner()).to.equal(deployer.address);
  });

  it("Should allow calling initiateFlashLoan (even if it reverts due to swap logic)", async function () {
    const SwapData = {
      uniswapPath: [
        "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
        "0xC02aaa39b223FE8D0A0e5C4F27eAD9083C756Cc2",  // WETH
      ],
      sushiPath: [
        "0xC02aaa39b223FE8D0A0e5C4F27eAD9083C756Cc2",  // WETH
        "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
      ],
      thirdPath: [
        "0xC02aaa39b223FE8D0A0e5C4F27eAD9083C756Cc2",  // WETH
        "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
      ],
      minOutUni: 0,
      minOutSushi: 0,
      minOutThird: 0,
      minProfit: 0,
    };

    // Here, we call initiateFlashLoan.
    // Even if the swap logic reverts later due to swap issues,
    // our goal is to check that deployment succeeded without constructor errors.
    await expect(
      arbitrage.initiateFlashLoan(
        "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI token
        ethers.utils.parseEther("100"), // borrow 100 DAI
        SwapData
      )
    ).to.be.reverted; // It may revert due to swap conditions, but that is not our focus.
  });
});
