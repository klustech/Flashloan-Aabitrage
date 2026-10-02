const { getNetworkConfig } = require('./networkConfig');
const { integer, address, serialize } = require('../bot/units');
const { utils } = require('ethers');
function productionProfile(env = process.env) {
  const network = getNetworkConfig('ethereum');
  const tokens = { ...network.tokens };
  if (env.TOKENS_DAI) tokens.DAI = env.TOKENS_DAI;
  if (env.TOKENS_WETH) tokens.WETH = env.TOKENS_WETH;
  const routers = {
    uniswap_v2: { ...network.dexRouters.uniswap_v2, router: env.UNISWAP_ROUTER_ADDRESS || network.dexRouters.uniswap_v2.router },
    sushiswap_v2: { ...network.dexRouters.sushiswap, router: env.SUSHISWAP_ROUTER_ADDRESS || network.dexRouters.sushiswap.router },
    uniswap_v3: { ...network.dexRouters.uniswap_v3, router: env.UNISWAP_V3_ROUTER || network.dexRouters.uniswap_v3.router, quoter: env.UNISWAP_V3_QUOTER || network.dexRouters.uniswap_v3.quoter, quoterVersion: 1, feeTiers: [100,500,3000,10000] },
    pancake_v3: {
      router: env.PANCAKE_V3_ROUTER || '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
      factory: env.PANCAKE_V3_FACTORY || '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
      quoter: env.PANCAKE_V3_QUOTER || '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
      quoterVersion: 2, feeTiers: [100,500,2500,10000],
    },
  };
  const profile = {
    chain: 'ethereum', chainId: 1, tokens, routers,
    tokenSymbols: (env.SCAN_TOKENS || 'DAI,WETH,USDC,USDT,WBTC').split(',').map(s=>s.trim()),
    borrowSymbols: (env.BORROW_TOKENS || 'DAI').split(',').map(s=>s.trim()),
    flashloanProvider: { protocol:'aave', version:2, addressesProvider:env.AAVE_LENDING_POOL_ADDRESS_PROVIDER || network.aave.v2.lendingPoolAddressProvider, lendingPool:env.AAVE_V2_LENDING_POOL || network.aave.v2.lendingPool },
    contractAddress: env.CONTRACT_ADDRESS,
    operatorAddress: env.OPERATOR_ADDRESS,
    expectedOwner: env.EXPECTED_CONTRACT_OWNER || env.OPERATOR_ADDRESS,
    expectedProfitRecipient: env.EXPECTED_PROFIT_RECIPIENT,
    expectedTimelock: env.EXPECTED_TIMELOCK,
    expectedContractCodeHash: env.EXPECTED_CONTRACT_CODE_HASH,
    maxBorrowAmount: env.MAX_BORROW_AMOUNT || '50000',
    minBorrowAmount: env.MIN_BORROW_AMOUNT || '1',
    minimumRequiredProfit: env.MIN_PROFIT_TOKEN || env.MIN_PROFIT_DAI || '1',
    maxGasUnits: integer(env.MAX_SINGLE_TRADE_GAS || 1500000,'MAX_SINGLE_TRADE_GAS',21000,10000000),
    gasCeilingGwei: env.GAS_PRICE_CEILING_GWEI || '50',
    maxQuoteAgeMs: integer(env.MAX_QUOTE_AGE_MS || 12000,'MAX_QUOTE_AGE_MS',100,60000),
    maxPoolStateAgeMs: integer(env.MAX_POOL_STATE_AGE_MS || 12000,'MAX_POOL_STATE_AGE_MS',100,60000),
    maxPriceMovementBps: integer(env.MAX_PRICE_MOVEMENT_BPS || 100,'MAX_PRICE_MOVEMENT_BPS',0,1000),
    maxBuilderShareBps: integer(env.MAX_BUILDER_SHARE_BPS || 1500,'MAX_BUILDER_SHARE_BPS',0,5000),
    slippageBps: integer(env.SLIPPAGE_DEFAULT_BIPS || 30,'SLIPPAGE_DEFAULT_BIPS',0,500),
    maxCandidates: integer(env.EXACT_QUOTE_CANDIDATES || 4,'EXACT_QUOTE_CANDIDATES',1,12),
    maxSizedCandidates: integer(env.SIZED_CANDIDATES || 1,'SIZED_CANDIDATES',1,3),
    sizingSamples: integer(env.SIZING_SAMPLES || 4,'SIZING_SAMPLES',2,10),
    sizingRefinements: integer(env.SIZING_REFINEMENTS || 1,'SIZING_REFINEMENTS',0,5),
    scanBudgetMs: integer(env.SCAN_BUDGET_MS || 5000,'SCAN_BUDGET_MS',250,10000),
    rpcConcurrency: integer(env.SCAN_RPC_CONCURRENCY || 8,'SCAN_RPC_CONCURRENCY',1,16),
    blockPollIntervalMs: integer(env.BLOCK_POLL_INTERVAL_MS || 1000,'BLOCK_POLL_INTERVAL_MS',250,3000),
    poolDiscoveryIntervalBlocks: integer(env.POOL_DISCOVERY_INTERVAL_BLOCKS || 300,'POOL_DISCOVERY_INTERVAL_BLOCKS',1,7200),
    maxCachedBlockGap: integer(env.MAX_CACHED_BLOCK_GAP || 64,'MAX_CACHED_BLOCK_GAP',1,256),
    maxRouteHops: 3,
    relays: (env.APPROVED_PRIVATE_RELAYS || 'https://relay.flashbots.net').split(',').map(s=>s.trim()),
    confirmations: integer(env.RECEIPT_CONFIRMATIONS || 2,'RECEIPT_CONFIRMATIONS',1,32),
    maxDailyLossNative: env.MAX_DAILY_LOSS_ETH || '0.02',
  };
  if (env.DEFAULT_CHAIN && env.DEFAULT_CHAIN !== 'ethereum') throw new Error('Production profile supports Ethereum only');
  for (const symbol of [...profile.tokenSymbols,...profile.borrowSymbols]) if (!tokens[symbol] || !profile.tokenSymbols.includes(symbol)) throw new Error(`Unknown/unscanned token ${symbol}`);
  for (const url of profile.relays) if (new URL(url).protocol !== 'https:') throw new Error('Private relay must use HTTPS');
  profile.fingerprint = utils.keccak256(utils.toUtf8Bytes(JSON.stringify(serialize(profile))));
  return Object.freeze(profile);
}
module.exports = { productionProfile };
