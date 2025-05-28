// test/unit/ArbitrageFlashloan.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArbitrageFlashloan - Unit Tests", function () {
  let deployer;
  let arbitrage;

  const AAVE_PROVIDER_MAINNET = "0xb53c1a33016b2dc2ff3653530bff1848a515c8c5";
  const UNISWAP_ROUTER_MAINNET = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const SUSHISWAP_ROUTER_MAINNET = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

  before(async function () {
    [deployer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ArbitrageFlashloan");
    arbitrage = await Factory.deploy(
      AAVE_PROVIDER_MAINNET,
      UNISWAP_ROUTER_MAINNET,
      SUSHISWAP_ROUTER_MAINNET
    );
    await arbitrage.deployed();
  });

  it("assigns deployer as owner", async () => {
    expect(await arbitrage.owner()).to.equal(deployer.address);
  });

  // add more pure unit tests here as needed
});
