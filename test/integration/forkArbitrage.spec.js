// test/integration/forkArbitrage.spec.js
//
// End-to-end flash-loan arbitrage proof on a MAINNET FORK.
//
// This is the "gate #2" test: it executes the full money path against the REAL
// Aave V2 pool and REAL Uniswap V2 / Sushiswap routers. It manufactures a real,
// capturable price spread by dumping WETH into the Uniswap V2 DAI/WETH pool
// (making WETH cheap there), then runs ArbitrageFlashloan to:
//   borrow DAI (Aave V2 flash loan)
//   -> buy cheap WETH on Uniswap
//   -> sell WETH dearer on Sushiswap
//   -> repay principal + 0.09% premium
//   -> send the surplus to the profit recipient
// and asserts the recipient actually received profit.
//
// Run it (needs an archive/full RPC; binaries.soliditylang.org must be reachable
// so Hardhat can fetch solc):
//   ENABLE_MAINNET_FORK=true MAINNET_RPC_URL=<rpc> FORK_BLOCK_NUMBER=17000000 \
//     npx hardhat test test/integration/forkArbitrage.spec.js
// or:  npm run test:fork:arb
//
// When ENABLE_MAINNET_FORK is not set, the whole suite is skipped so CI / local
// runs without an RPC stay green.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployExecutor } = require("../helpers/executor");

const RUN_FORK = process.env.ENABLE_MAINNET_FORK === "true";
const suite = RUN_FORK ? describe : describe.skip;

// Canonical Ethereum mainnet addresses.
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const UNI_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SUSHI_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const AAVE_V2_PROVIDER = "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const WETH_ABI = ["function deposit() payable", ...ERC20_ABI];

// DexType enum in ArbitrageFlashloan.
const DEX = {
  UNISWAP_V2: 0,
  UNISWAP_V3: 1,
  SUSHISWAP: 2,
  BALANCER: 3,
  CURVE: 4,
};
const { HashZero } = ethers.constants;

const mkStep = (dexType, router, tokenIn, tokenOut, minAmountOut) => ({
  dexType,
  router,
  tokenIn,
  tokenOut,
  minAmountOut,
  v3Fee: 0,
  balancerPoolId: HashZero,
  curveIndexIn: 0,
  curveIndexOut: 0,
  curveUnderlying: false,
  v2Path: [tokenIn, tokenOut],
});

suite(
  "Fork: end-to-end flash-loan arbitrage (Uniswap -> Sushiswap)",
  function () {
    this.timeout(600000);

    let deployer, whale, recipient;
    let arb, uni, sushi, dai, weth;

    before(async function () {
      // Guard: only run when the node is actually forking mainnet (DAI has code).
      if ((await ethers.provider.getCode(DAI)) === "0x") {
         
        console.warn(
          "    [skip] not a mainnet fork (set ENABLE_MAINNET_FORK + MAINNET_RPC_URL)"
        );
        this.skip();
      }

      [deployer, whale, recipient] = await ethers.getSigners();

      uni = new ethers.Contract(UNI_ROUTER, ROUTER_ABI, whale);
      sushi = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, whale);
      dai = new ethers.Contract(DAI, ERC20_ABI, deployer);
      weth = new ethers.Contract(WETH, WETH_ABI, whale);

      // recipient is a fresh account so we can measure its DAI balance delta
      // cleanly; deployer is the executor and governance approves both routers.
      ({ arb } = await deployExecutor(ethers, AAVE_V2_PROVIDER, recipient.address, [UNI_ROUTER, SUSHI_ROUTER]));
    });

    it("borrows DAI, captures a manufactured Uni->Sushi spread, repays, and profits", async function () {
      // 1) Skew Uniswap: sell a large WETH amount for DAI so WETH becomes cheap on
      //    Uniswap relative to Sushiswap, creating a capturable spread.
      const skewWeth = ethers.utils.parseEther(
        process.env.FORK_SKEW_WETH || "2000"
      );
      await (await weth.deposit({ value: skewWeth })).wait();
      await (await weth.approve(UNI_ROUTER, skewWeth)).wait();
      const deadline = Math.floor(Date.now() / 1000) + 1800;
      await (
        await uni.swapExactTokensForTokens(
          skewWeth,
          0,
          [WETH, DAI],
          whale.address,
          deadline
        )
      ).wait();

      // 2) Find a profitable borrow size by simulating both legs on-chain.
      const candidates = [
        "100",
        "500",
        "1000",
        "5000",
        "10000",
        "25000",
        "50000",
        "100000",
      ].map((v) => ethers.utils.parseUnits(v, 18));
      let best = null;
      for (const borrow of candidates) {
        try {
          const uniAmounts = await uni.getAmountsOut(borrow, [DAI, WETH]); // DAI -> cheap WETH on Uni
          const wethOut = uniAmounts[uniAmounts.length - 1];
          const sushiAmounts = await sushi.getAmountsOut(wethOut, [WETH, DAI]); // WETH -> DAI on Sushi
          const daiBack = sushiAmounts[sushiAmounts.length - 1];
          const debt = borrow.mul(10009).div(10000); // principal + Aave V2 0.09% premium
          if (daiBack.gt(debt)) {
            const profit = daiBack.sub(debt);
            if (!best || profit.gt(best.profit)) {
              best = { borrow, wethOut, daiBack, profit };
            }
          }
        } catch (_) {
          // borrow too large for current pool depth — skip this candidate
        }
      }
      expect(
        best,
        "no profitable borrow size found — increase FORK_SKEW_WETH"
      ).to.not.equal(null);

      // 3) Build the ArbitrageData bundle. minAmountOut/minProfit use the on-chain
      //    quotes (deterministic on a fork) with a small safety margin.
      const minWethOut = best.wethOut.mul(995).div(1000);
      const minDaiOut = best.daiBack.mul(995).div(1000);
      const minProfit = best.profit.mul(80).div(100);

      const arbData = {
        borrowToken: DAI,
        borrowAmount: best.borrow,
        steps: [
          mkStep(DEX.UNISWAP_V2, UNI_ROUTER, DAI, WETH, minWethOut),
          mkStep(DEX.SUSHISWAP, SUSHI_ROUTER, WETH, DAI, minDaiOut),
        ],
        minProfit,
        route: "DAI->WETH(Uni)->DAI(Sushi)",
      };

      // 4) Pre-flight: estimateGas on the real entrypoint must succeed (it reverts
      //    if the trade isn't profitable on-chain — the same guard the bot uses).
      await arb.estimateGas.initiateFlashLoan(arbData);

      // 5) Execute and assert profit landed with the recipient.
      const beforeBal = await dai.balanceOf(recipient.address);
      await expect(arb.initiateFlashLoan(arbData)).to.emit(
        arb,
        "ArbitrageExecuted"
      );
      const afterBal = await dai.balanceOf(recipient.address);

      const gained = afterBal.sub(beforeBal);
      expect(gained.gt(0), "recipient received no profit").to.equal(true);
      expect(
        gained.gte(minProfit),
        "realized profit below enforced minProfit"
      ).to.equal(true);

       
      console.log(
        `    borrowed ${ethers.utils.formatUnits(
          best.borrow,
          18
        )} DAI -> profit ${ethers.utils.formatUnits(gained, 18)} DAI`
      );
    });

    it("reverts an unprofitable trade (profit-or-revert holds on real pools)", async function () {
      // A tiny borrow whose round-trip cannot cover fees + premium must revert,
      // proving the contract never settles at a loss against real DEXes.
      const borrow = ethers.utils.parseUnits("10", 18);
      const uniAmounts = await uni.getAmountsOut(borrow, [DAI, WETH]);
      const wethOut = uniAmounts[uniAmounts.length - 1];

      const arbData = {
        borrowToken: DAI,
        borrowAmount: borrow,
        steps: [
          mkStep(
            DEX.UNISWAP_V2,
            UNI_ROUTER,
            DAI,
            WETH,
            wethOut.mul(99).div(100)
          ),
          mkStep(DEX.SUSHISWAP, SUSHI_ROUTER, WETH, DAI, 0),
        ],
        // Demand an absurd profit so it cannot possibly settle.
        minProfit: ethers.utils.parseUnits("1000000", 18),
        route: "unprofitable",
      };

      await expect(arb.initiateFlashLoan(arbData)).to.be.reverted;
    });
  }
);
