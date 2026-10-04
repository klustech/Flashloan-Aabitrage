const { getNetworkConfig } = require('./networkConfig');
const { integer, address, serialize } = require('../bot/units');
const { utils } = require('ethers');
const {paperOnly,assertPaperConfiguration}=require('./paperPolicy');

const BACKRUN_DEFAULTS = Object.freeze({
  WETH: { minBorrow: '0.01', maxBorrow: '25', minimumProfit: '0.00005' },
  DAI:  { minBorrow: '100',  maxBorrow: '50000', minimumProfit: '1' },
  USDC: { minBorrow: '100',  maxBorrow: '50000', minimumProfit: '1' },
  USDT: { minBorrow: '100',  maxBorrow: '50000', minimumProfit: '1' },
  WBTC: { minBorrow: '0.001',maxBorrow: '2', minimumProfit: '0.00001' },
});

function list(value, fallback='') {
  return String(value || fallback).split(',').map(s=>s.trim()).filter(Boolean);
}
function envAmount(env, prefix, symbol, fallback) {
  return env[`${prefix}_${symbol}`] || fallback;
}
function productionProfile(env = process.env) {
  assertPaperConfiguration(env);
  const network = getNetworkConfig('ethereum');
  const tokens = { ...network.tokens };
  for (const symbol of ['DAI','WETH','USDC','USDT','WBTC']) {
    if (env[`TOKENS_${symbol}`]) tokens[symbol] = env[`TOKENS_${symbol}`];
  }
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
  const opportunityMode=String(env.OPPORTUNITY_MODE||'block').trim().toLowerCase();
  if(!['block','backrun','hybrid'].includes(opportunityMode))throw new Error('OPPORTUNITY_MODE must be block, backrun or hybrid');
  const backrunBorrowSymbols=list(env.BACKRUN_BORROW_TOKENS,'WETH,DAI,USDC');
  const fundingModes=list(env.BACKRUN_FUNDING_MODES,'TREASURY,AAVE_FLASH_LOAN').map(s=>s.toUpperCase());
  for(const mode of fundingModes)if(!['TREASURY','AAVE_FLASH_LOAN'].includes(mode))throw new Error(`Unsupported BACKRUN_FUNDING_MODE ${mode}`);
  const backrunLimits={};
  for(const symbol of backrunBorrowSymbols){
    const defaults=BACKRUN_DEFAULTS[symbol]||{minBorrow:'1',maxBorrow:'10000',minimumProfit:'1'};
    backrunLimits[symbol]=Object.freeze({
      minBorrow:envAmount(env,'BACKRUN_MIN_BORROW',symbol,defaults.minBorrow),
      maxBorrow:envAmount(env,'BACKRUN_MAX_BORROW',symbol,defaults.maxBorrow),
      minimumProfit:envAmount(env,'BACKRUN_MIN_PROFIT',symbol,defaults.minimumProfit),
    });
  }
  const profile = {
    chain: 'ethereum', chainId: 1, paperOnly:paperOnly(env), tokens, routers,
    opportunityMode,
    tokenSymbols: list(env.SCAN_TOKENS,'DAI,WETH,USDC,USDT,WBTC'),
    borrowSymbols: list(env.BORROW_TOKENS,'DAI'),
    backrunBorrowSymbols,
    backrunLimits,
    backrun: Object.freeze({
      enabled: opportunityMode==='backrun'||opportunityMode==='hybrid',
      sources:list(env.BACKRUN_ORDER_FLOW_SOURCES,'mev_share'),
      requireStatePrediction: String(env.BACKRUN_REQUIRE_STATE_PREDICTION||'true').toLowerCase()!=='false',
      traceTimeoutMs:integer(env.BACKRUN_TRACE_TIMEOUT_MS||2500,'BACKRUN_TRACE_TIMEOUT_MS',250,15000),
      budgetMs:integer(env.BACKRUN_BUDGET_MS||4000,'BACKRUN_BUDGET_MS',250,10000),
      maxCandidates:integer(env.BACKRUN_EXACT_QUOTE_CANDIDATES||12,'BACKRUN_EXACT_QUOTE_CANDIDATES',1,32),
      maxSizedCandidates:integer(env.BACKRUN_SIZED_CANDIDATES||2,'BACKRUN_SIZED_CANDIDATES',1,4),
      eventTtlMs:integer(env.BACKRUN_EVENT_TTL_MS||12000,'BACKRUN_EVENT_TTL_MS',1000,60000),
      mevShareStreamUrl:env.MEV_SHARE_STREAM_URL||'https://mev-share.flashbots.net/api/v1/transactions',
      mevShareApiUrl:env.MEV_SHARE_API_URL||'https://relay.flashbots.net',
      builders:list(env.MEV_SHARE_BUILDERS,'default'),
      fundingModes,
      publicPendingEnabled:String(env.PUBLIC_PENDING_BACKRUN||'false').toLowerCase()==='true',
      extraRouters:list(env.BACKRUN_EXTRA_ROUTERS),
    }),
    flashloanProvider: { protocol:'aave', version:2, addressesProvider:env.AAVE_LENDING_POOL_ADDRESS_PROVIDER || network.aave.v2.lendingPoolAddressProvider, lendingPool:env.AAVE_V2_LENDING_POOL || network.aave.v2.lendingPool },
    contractAddress: env.CONTRACT_ADDRESS,
    operatorAddress: env.OPERATOR_ADDRESS,
    expectedOwner: env.EXPECTED_CONTRACT_OWNER || env.OPERATOR_ADDRESS,
    expectedProfitRecipient: env.EXPECTED_PROFIT_RECIPIENT,
    expectedTimelock: env.EXPECTED_TIMELOCK,
    expectedContractCodeHash: env.EXPECTED_CONTRACT_CODE_HASH,
    requiredExecutorVersion:integer(env.REQUIRED_EXECUTOR_VERSION||2,'REQUIRED_EXECUTOR_VERSION',2,100),
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
    maxScreenedCandidates: integer(env.MAX_SCREENED_CANDIDATES || 48,'MAX_SCREENED_CANDIDATES',1,128),
    maxSizedCandidates: integer(env.SIZED_CANDIDATES || 1,'SIZED_CANDIDATES',1,3),
    sizingSamples: integer(env.SIZING_SAMPLES || 4,'SIZING_SAMPLES',2,10),
    sizingRefinements: integer(env.SIZING_REFINEMENTS || 1,'SIZING_REFINEMENTS',0,5),
    scanBudgetMs: integer(env.SCAN_BUDGET_MS || 5000,'SCAN_BUDGET_MS',250,10000),
    rpcConcurrency: integer(env.SCAN_RPC_CONCURRENCY || 8,'SCAN_RPC_CONCURRENCY',1,16),
    blockPollIntervalMs: integer(env.BLOCK_POLL_INTERVAL_MS || 1000,'BLOCK_POLL_INTERVAL_MS',250,3000),
    poolDiscoveryIntervalBlocks: integer(env.POOL_DISCOVERY_INTERVAL_BLOCKS || 300,'POOL_DISCOVERY_INTERVAL_BLOCKS',1,7200),
    maxCachedBlockGap: integer(env.MAX_CACHED_BLOCK_GAP || 64,'MAX_CACHED_BLOCK_GAP',1,256),
    maxRouteHops: 3,
    relays: list(env.APPROVED_PRIVATE_RELAYS,'https://relay.flashbots.net'),
    confirmations: integer(env.RECEIPT_CONFIRMATIONS || 2,'RECEIPT_CONFIRMATIONS',1,32),
    maxDailyLossNative: env.MAX_DAILY_LOSS_ETH || '0.02',
  };
  if (env.DEFAULT_CHAIN && env.DEFAULT_CHAIN !== 'ethereum') throw new Error('Production profile supports Ethereum only');
  for (const symbol of [...profile.tokenSymbols,...profile.borrowSymbols,...profile.backrunBorrowSymbols]) if (!tokens[symbol] || !profile.tokenSymbols.includes(symbol)) throw new Error(`Unknown/unscanned token ${symbol}`);
  for (const url of [...profile.relays,profile.backrun.mevShareApiUrl,profile.backrun.mevShareStreamUrl]) if (new URL(url).protocol !== 'https:') throw new Error('Private relay/order-flow endpoints must use HTTPS');
  profile.fingerprint = utils.keccak256(utils.toUtf8Bytes(JSON.stringify(serialize(profile))));
  return Object.freeze(profile);
}
module.exports = { productionProfile, BACKRUN_DEFAULTS };
