const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArbitrageFlashloan - Unit Tests", function () {
  let deployer;
  let arbitrage;

  // Use mainnet addresses for testing on a fork:
  const AAVE_PROVIDER_MAINNET = "0xb53c1a33016b2dc2ff3653530bff1848a515c8c5"; // Aave LendingPoolAddressesProvider V2
  const UNISWAP_ROUTER_MAINNET = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";   // Uniswap V2 Router02
  const SUSHISWAP_ROUTER_MAINNET = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";   // SushiSwap Router

  before(async function () {
    [deployer] = await ethers.getSigners();

    const ArbitrageFlashloan = await ethers.getContractFactory("ArbitrageFlashloan");

    // Deploy with exactly three constructor arguments and explicit gas overrides.
    arbitrage = await ArbitrageFlashloan.deploy(
      AAVE_PROVIDER_MAINNET,
      UNISWAP_ROUTER_MAINNET,
      SUSHISWAP_ROUTER_MAINNET,
      {
        maxFeePerGas: ethers.utils.parseUnits("100", "gwei"),
        maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei"),
        gasLimit: 6000000
      }
    );
    await arbitrage.deployed();
  });

  it("Should assign the contract deployer as the owner", async function () {
    expect(await arbitrage.owner()).to.equal(deployer.address);
  });

  // Add further unit tests below as needed.
});
