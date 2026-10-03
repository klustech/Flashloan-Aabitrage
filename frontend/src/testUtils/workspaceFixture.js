export const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const record = {
  id: "paper-one",
  candidateId: "cycle-one",
  mode: "PAPER",
  status: "SIMULATED",
  updatedAt: Date.now(),
  stateBlock: 26110100,
  borrowToken: DAI,
  token: { symbol: "DAI", decimals: 18 },
  route: {
    strategy: "CROSS_DEX_TWO_LEG",
    legs: [
      {
        dex: "uniswap_v2",
        poolAddress: "0x1111111111111111111111111111111111111111",
        tokenIn: DAI,
        tokenOut: WETH,
      },
      {
        dex: "uniswap_v3",
        poolAddress: "0x2222222222222222222222222222222222222222",
        tokenIn: WETH,
        tokenOut: DAI,
        feeTier: 3000,
      },
    ],
  },
  economics: {
    borrowAmount: "1000000000000000000000",
    expectedFinalAmount: "1500000000000000000000",
    flashloanFee: "900000000000000000",
    estimatedGasCostBorrowToken: "1000000000000000000",
    estimatedBuilderPaymentBorrowToken: "1000000000000000000",
    expectedNetProfit: "497100000000000000000",
  },
  simulation: { callStatic: true, bundle: false },
};
export function snapshot(state = "PAPER") {
  return {
    trading: {
      state,
      armed: state === "LIVE_ARMED",
      armedUntil: state === "LIVE_ARMED" ? Date.now() + 60000 : 0,
    },
    summary: {
      pending: 0,
      total: 1,
      tokens: {
        [DAI]: {
          borrowToken: DAI,
          token: { symbol: "DAI", decimals: 18 },
          realizedNet: "0",
          expectedPaperNet: "497100000000000000000",
          realizedGasNative: "0",
        },
      },
    },
    executions: [record],
    latency: {
      durationMs: 240,
      cache: { block: 26110100, pools: 77, reusedPools: 75, logFallbacks: 0 },
      screened: 12,
      sized: 1,
      transactionCalls: 2,
      gasEstimates: 1,
      screeningBatches: 3,
      screeningPassed: 1,
      screeningStopReason: "enough_profitable",
      stageTimes: {
        cacheMs: 20,
        screeningMs: 90,
        sizingMs: 80,
        preparationMs: 50,
      },
      candidates: { profitableMarginal: 443 },
    },
    scanner: { source: "http", scans: 12 },
    paperBurnIn: {
      simulated: 1,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    },
  };
}
