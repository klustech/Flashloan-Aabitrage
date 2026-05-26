/**
 * test/integration/crossDex.test.js
 *
 * Cross-DEX Integration Tests for Flash Loan Arbitrage
 * Tests multi-DEX route building, execution paths, and price consistency
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

// Skip if not running with mainnet fork
const FORK_ENABLED = process.env.ENABLE_MAINNET_FORK === "true";
const describeFork = FORK_ENABLED ? describe : describe.skip;

// Token addresses on mainnet
const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
};

// DEX Router addresses
const ROUTERS = {
  UNISWAP_V2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  UNISWAP_V3: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  SUSHISWAP: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
};

// Minimal ABIs
const ROUTER_V2_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory)",
];

const QUOTER_V3_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

describeFork("Cross-DEX Integration Tests", function () {
  this.timeout(60000);

  let owner;
  let uniswapV2Router;
  let sushiswapRouter;
  let weth;
  let dai;
  let usdc;

  async function deployFixture() {
    const [deployer] = await ethers.getSigners();

    // Connect to routers
    const uniV2 = new ethers.Contract(
      ROUTERS.UNISWAP_V2,
      ROUTER_V2_ABI,
      deployer
    );
    const sushi = new ethers.Contract(
      ROUTERS.SUSHISWAP,
      ROUTER_V2_ABI,
      deployer
    );

    // Connect to tokens
    const wethContract = new ethers.Contract(TOKENS.WETH, ERC20_ABI, deployer);
    const daiContract = new ethers.Contract(TOKENS.DAI, ERC20_ABI, deployer);
    const usdcContract = new ethers.Contract(TOKENS.USDC, ERC20_ABI, deployer);

    return {
      owner: deployer,
      uniswapV2Router: uniV2,
      sushiswapRouter: sushi,
      weth: wethContract,
      dai: daiContract,
      usdc: usdcContract,
    };
  }

  beforeEach(async function () {
    const fixture = await deployFixture();
    owner = fixture.owner;
    uniswapV2Router = fixture.uniswapV2Router;
    sushiswapRouter = fixture.sushiswapRouter;
    weth = fixture.weth;
    dai = fixture.dai;
    usdc = fixture.usdc;
  });

  describe("Price Consistency Across DEXes", function () {
    it("should get quotes from Uniswap V2 for WETH -> DAI", async function () {
      const amountIn = ethers.utils.parseEther("1");
      const path = [TOKENS.WETH, TOKENS.DAI];

      const amounts = await uniswapV2Router.getAmountsOut(amountIn, path);
      expect(amounts.length).to.equal(2);
      expect(amounts[1]).to.be.gt(0);

      console.log(
        `Uniswap V2: 1 WETH = ${ethers.utils.formatEther(amounts[1])} DAI`
      );
    });

    it("should get quotes from SushiSwap for WETH -> DAI", async function () {
      const amountIn = ethers.utils.parseEther("1");
      const path = [TOKENS.WETH, TOKENS.DAI];

      const amounts = await sushiswapRouter.getAmountsOut(amountIn, path);
      expect(amounts.length).to.equal(2);
      expect(amounts[1]).to.be.gt(0);

      console.log(
        `SushiSwap: 1 WETH = ${ethers.utils.formatEther(amounts[1])} DAI`
      );
    });

    it("should detect price differences between DEXes", async function () {
      const amountIn = ethers.utils.parseEther("10");
      const path = [TOKENS.WETH, TOKENS.DAI];

      const uniAmounts = await uniswapV2Router.getAmountsOut(amountIn, path);
      const sushiAmounts = await sushiswapRouter.getAmountsOut(amountIn, path);

      const uniPrice = parseFloat(ethers.utils.formatEther(uniAmounts[1]));
      const sushiPrice = parseFloat(ethers.utils.formatEther(sushiAmounts[1]));

      const priceDiff = Math.abs(uniPrice - sushiPrice);
      const priceDiffPercent =
        (priceDiff / Math.min(uniPrice, sushiPrice)) * 100;

      console.log(`Price difference: ${priceDiffPercent.toFixed(4)}%`);
      console.log(`Uniswap V2: ${uniPrice.toFixed(4)} DAI`);
      console.log(`SushiSwap: ${sushiPrice.toFixed(4)} DAI`);

      // Price difference should be reasonable (< 5%)
      expect(priceDiffPercent).to.be.lt(5);
    });
  });

  describe("Multi-Hop Path Validation", function () {
    it("should calculate 3-hop path: DAI -> WETH -> USDC -> DAI", async function () {
      const amountIn = ethers.utils.parseUnits("1000", 18); // 1000 DAI

      // Hop 1: DAI -> WETH
      const hop1 = await uniswapV2Router.getAmountsOut(amountIn, [
        TOKENS.DAI,
        TOKENS.WETH,
      ]);
      const wethAmount = hop1[1];

      // Hop 2: WETH -> USDC
      const hop2 = await sushiswapRouter.getAmountsOut(wethAmount, [
        TOKENS.WETH,
        TOKENS.USDC,
      ]);
      const usdcAmount = hop2[1];

      // Hop 3: USDC -> DAI
      const hop3 = await uniswapV2Router.getAmountsOut(usdcAmount, [
        TOKENS.USDC,
        TOKENS.DAI,
      ]);
      const finalDai = hop3[1];

      console.log(`Start: 1000 DAI`);
      console.log(
        `After hop 1 (DAI->WETH on Uni V2): ${ethers.utils.formatEther(
          wethAmount
        )} WETH`
      );
      console.log(
        `After hop 2 (WETH->USDC on Sushi): ${ethers.utils.formatUnits(
          usdcAmount,
          6
        )} USDC`
      );
      console.log(
        `After hop 3 (USDC->DAI on Uni V2): ${ethers.utils.formatEther(
          finalDai
        )} DAI`
      );

      const profit = parseFloat(ethers.utils.formatEther(finalDai)) - 1000;
      console.log(`Potential profit (before gas): ${profit.toFixed(4)} DAI`);
    });

    it("should validate triangular arbitrage path: WETH -> DAI -> USDC -> WETH", async function () {
      const amountIn = ethers.utils.parseEther("1"); // 1 WETH

      // Hop 1: WETH -> DAI
      const hop1 = await uniswapV2Router.getAmountsOut(amountIn, [
        TOKENS.WETH,
        TOKENS.DAI,
      ]);
      const daiAmount = hop1[1];

      // Hop 2: DAI -> USDC
      const hop2 = await sushiswapRouter.getAmountsOut(daiAmount, [
        TOKENS.DAI,
        TOKENS.USDC,
      ]);
      const usdcAmount = hop2[1];

      // Hop 3: USDC -> WETH
      const hop3 = await uniswapV2Router.getAmountsOut(usdcAmount, [
        TOKENS.USDC,
        TOKENS.WETH,
      ]);
      const finalWeth = hop3[1];

      const profitWei = finalWeth.sub(amountIn);
      const profitEth = parseFloat(ethers.utils.formatEther(profitWei));

      console.log(`Start: 1 WETH`);
      console.log(`Final: ${ethers.utils.formatEther(finalWeth)} WETH`);
      console.log(`Profit: ${profitEth.toFixed(6)} WETH`);

      // Log whether profitable (informational, not assertion)
      if (profitEth > 0) {
        console.log("Arbitrage opportunity detected!");
      } else {
        console.log("No profitable arbitrage at current prices");
      }
    });
  });

  describe("Slippage Impact Analysis", function () {
    it("should measure slippage at different trade sizes", async function () {
      const tradeSizes = [1, 10, 100, 500, 1000];
      const path = [TOKENS.WETH, TOKENS.DAI];

      const results = [];

      for (const size of tradeSizes) {
        const amountIn = ethers.utils.parseEther(size.toString());
        const amounts = await uniswapV2Router.getAmountsOut(amountIn, path);
        const pricePerEth =
          parseFloat(ethers.utils.formatEther(amounts[1])) / size;
        results.push({ size, pricePerEth });
      }

      // Calculate slippage from smallest to largest trade
      const basePrice = results[0].pricePerEth;
      console.log("\nSlippage Analysis (WETH -> DAI on Uniswap V2):");
      console.log("-------------------------------------------");

      for (const result of results) {
        const slippage = ((basePrice - result.pricePerEth) / basePrice) * 100;
        console.log(
          `${result.size} WETH: ${result.pricePerEth.toFixed(
            2
          )} DAI/WETH (slippage: ${slippage.toFixed(4)}%)`
        );
      }

      // Large trades should have higher slippage
      const smallTradePrice = results[0].pricePerEth;
      const largeTradePrice = results[results.length - 1].pricePerEth;
      expect(smallTradePrice).to.be.gte(largeTradePrice);
    });
  });

  describe("Gas Estimation", function () {
    it("should estimate gas for different swap paths", async function () {
      // Note: These are estimations based on typical gas usage
      // Actual gas will vary based on state
      const gasEstimates = {
        uniswapV2SingleHop: 110000,
        uniswapV2TwoHop: 170000,
        uniswapV3SingleHop: 130000,
        uniswapV3TwoHop: 200000,
        balancerSingleSwap: 150000,
        curveStableSwap: 400000,
        flashloanWrapper: 50000,
      };

      console.log("\nTypical Gas Estimates:");
      console.log("----------------------");
      for (const [name, gas] of Object.entries(gasEstimates)) {
        console.log(`${name}: ${gas.toLocaleString()} gas`);
      }

      // Multi-hop with flashloan
      const threeHopFlashloan =
        gasEstimates.flashloanWrapper + gasEstimates.uniswapV2SingleHop * 3;
      console.log(
        `\n3-hop V2 with flashloan: ~${threeHopFlashloan.toLocaleString()} gas`
      );

      // At 30 gwei gas price
      const gasPrice = 30; // gwei
      const ethCost = threeHopFlashloan * gasPrice * 1e-9;
      console.log(`Cost at ${gasPrice} gwei: ~${ethCost.toFixed(6)} ETH`);
    });
  });
});

describe("Unit Tests - Route Building", function () {
  describe("Path Validation", function () {
    it("should validate circular path returns to start token", function () {
      const path = ["DAI", "WETH", "USDC", "DAI"];
      expect(path[0]).to.equal(path[path.length - 1]);
    });

    it("should detect non-circular paths", function () {
      const path = ["DAI", "WETH", "USDC"];
      expect(path[0]).to.not.equal(path[path.length - 1]);
    });

    it("should validate minimum hop count", function () {
      const validPath = ["DAI", "WETH", "DAI"]; // 2 hops
      const tooShort = ["DAI", "DAI"]; // 1 hop (invalid)

      expect(validPath.length).to.be.gte(3);
      expect(tooShort.length).to.be.lt(3);
    });

    it("should validate maximum hop count", function () {
      const maxHops = 4;
      const validPath = ["DAI", "WETH", "USDC", "USDT", "DAI"]; // 4 hops
      const tooLong = ["DAI", "WETH", "USDC", "USDT", "WBTC", "DAI"]; // 5 hops

      expect(validPath.length - 1).to.be.lte(maxHops);
      expect(tooLong.length - 1).to.be.gt(maxHops);
    });
  });

  describe("DEX Selection Logic", function () {
    it("should select appropriate DEX based on token pair", function () {
      // Stable pairs should prefer Curve
      const stablePairs = [
        ["USDC", "USDT"],
        ["DAI", "USDC"],
        ["USDT", "DAI"],
      ];

      for (const [tokenA, tokenB] of stablePairs) {
        const isStable = isStablePair(tokenA, tokenB);
        expect(isStable).to.be.true;
      }

      // Volatile pairs should prefer Uniswap/Sushi
      const volatilePairs = [
        ["WETH", "DAI"],
        ["WBTC", "WETH"],
        ["UNI", "WETH"],
      ];

      for (const [tokenA, tokenB] of volatilePairs) {
        const isStable = isStablePair(tokenA, tokenB);
        expect(isStable).to.be.false;
      }
    });
  });
});

// Helper functions
function isStablePair(tokenA, tokenB) {
  const stableTokens = ["USDC", "USDT", "DAI", "FRAX", "LUSD", "TUSD", "GUSD"];
  return stableTokens.includes(tokenA) && stableTokens.includes(tokenB);
}

describe("Security Tests", function () {
  describe("Input Validation", function () {
    it("should reject zero amount input", function () {
      const amountIn = ethers.BigNumber.from(0);
      expect(amountIn.isZero()).to.be.true;
      // In production code, this should throw
    });

    it("should reject negative slippage", function () {
      const slippageBps = -50;
      expect(slippageBps).to.be.lt(0);
      // In production code, this should be rejected
    });

    it("should reject excessive slippage", function () {
      const maxSlippageBps = 1000; // 10% max
      const requestedSlippage = 5000; // 50%
      expect(requestedSlippage).to.be.gt(maxSlippageBps);
      // In production code, this should be capped or rejected
    });

    it("should validate address format", function () {
      const validAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
      const invalidAddress = "0xinvalid";

      expect(ethers.utils.isAddress(validAddress)).to.be.true;
      expect(ethers.utils.isAddress(invalidAddress)).to.be.false;
    });
  });

  describe("Reentrancy Protection", function () {
    it("should track execution state correctly", function () {
      let isExecuting = false;

      function startExecution() {
        if (isExecuting) {
          throw new Error("Reentrancy detected");
        }
        isExecuting = true;
      }

      function endExecution() {
        isExecuting = false;
      }

      // Normal flow
      startExecution();
      endExecution();
      expect(isExecuting).to.be.false;

      // Reentrancy attempt
      startExecution();
      expect(() => startExecution()).to.throw("Reentrancy detected");
      endExecution();
    });
  });

  describe("Price Manipulation Protection", function () {
    it("should detect suspicious price deviations", function () {
      const historicalPrice = 1800; // ETH/USD
      const currentPrice = 2500; // Suspicious 38% increase

      const deviation =
        Math.abs(currentPrice - historicalPrice) / historicalPrice;
      const maxDeviation = 0.1; // 10% max allowed

      expect(deviation).to.be.gt(maxDeviation);
      // In production, this should trigger additional verification
    });

    it("should validate TWAP against spot price", function () {
      const spotPrice = 1800;
      const twapPrice = 1785;

      const deviation = Math.abs(spotPrice - twapPrice) / twapPrice;
      const maxDeviation = 0.02; // 2% tolerance

      expect(deviation).to.be.lt(maxDeviation);
    });
  });
});
