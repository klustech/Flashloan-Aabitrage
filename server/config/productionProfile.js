const { getNetworkConfig } = require('./networkConfig');
const { integer, address, serialize } = require('../bot/units');
const { utils } = require('ethers');
const {paperOnly,assertPaperConfiguration}=require('./paperPolicy');
function optionalPositiveDecimal(value,name){
  if(value===undefined||value===null||String(value).trim()==='')return null;
  const text=String(value).trim();
  if(!/^\d+(?:\.\d+)?$/.test(text)||Number(text)<=0)throw new Error(`${name} must be a positive decimal`);
  return text;
}
function productionProfile(env = process.env) {
  assertPaperConfiguration(env);
  const network = getNetworkConfig('ethereum');
  const backrunBorrowSymbols=(env.BACKRUN_BORROW_TOKENS || 'WETH,DAI,USDC').split(',').map(s=>s.trim()).filter(Boolean);
  const backrunMinimumProfitBySymbol=Object.fromEntries(backrunBorrowSymbols.map(symbol=>[symbol,optionalPositiveDecimal(env[`BACKRUN_MIN_PROFIT_${symbol}`],`BACKRUN_MIN_PROFIT_${symbol}`)]));
  const backrunMaxAmountBySymbol=Object.fromEntries(backrunBorrowSymbols.map(symbol=>[symbol,optionalPositiveDecimal(env[`BACKRUN_MAX_AMOUNT_${symbol}`],`BACKRUN_MAX_AMOUNT_${symbol}`)]));
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
    chain: 'ethereum', chainId: 1, paperOnly:paperOnly(env), tokens, routers,
    tokenSymbols: (env.SCAN_TOKENS || 'DAI,WETH,USDC,USDT,WBTC').split(',').map(s=>s.trim()),
    borrowSymbols: (env.BORROW_TOKENS || 'DAI').split(',').map(s=>s.trim()),
    flashloanProvider: { protocol:'aave', version:2, addressesProvider:env.AAVE_LENDING_POOL_ADDRESS_PROVIDER || network.aave.v2.lendingPoolAddressProvider, lendingPool:env.AAVE_V2_LENDING_POOL || network.aave.v2.lendingPool },
    contractAddress: env.CONTRACT_ADDRESS,
    operatorAddress: env.OPERATOR_ADDRESS,
    // Governance (multisig-controlled timelock) that administers the executor.
    expectedAdmin: env.EXPECTED_ADMIN,
    expectedProfitRecipient: env.EXPECTED_PROFIT_RECIPIENT,
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
    relays: (env.APPROVED_PRIVATE_RELAYS || 'https://relay.flashbots.net').split(',').map(s=>s.trim()),
    confirmations: integer(env.RECEIPT_CONFIRMATIONS || 2,'RECEIPT_CONFIRMATIONS',1,32),
    maxDailyLossNative: env.MAX_DAILY_LOSS_ETH || '0.02',
    backrun: {
      enabled: String(env.BACKRUN_ENABLED || 'false').toLowerCase() === 'true',
      borrowSymbols: backrunBorrowSymbols,
      minimumProfitBySymbol: backrunMinimumProfitBySymbol,
      maxAmountBySymbol: backrunMaxAmountBySymbol,
      fundingMode: String(env.BACKRUN_FUNDING_MODE || 'adaptive').toLowerCase(),
      capitalReserveBps: integer(env.BACKRUN_CAPITAL_RESERVE_BPS || 1000,'BACKRUN_CAPITAL_RESERVE_BPS',0,9900),
      maxCandidates: integer(env.BACKRUN_MAX_CANDIDATES || 32,'BACKRUN_MAX_CANDIDATES',1,128),
      orderflowSource: String(env.BACKRUN_ORDERFLOW_SOURCE || 'disabled').toLowerCase(),
      mevShareStreamUrl: env.BACKRUN_MEV_SHARE_STREAM_URL || 'https://mev-share.flashbots.net',
      mevShareRelayUrl: env.BACKRUN_MEV_SHARE_RELAY_URL || 'https://relay.flashbots.net',
      mevShareBuilders: (env.BACKRUN_MEV_SHARE_BUILDERS || '').split(',').map(s=>s.trim()).filter(Boolean),
      forkRpcUrl: env.BACKRUN_FORK_RPC_URL || 'http://127.0.0.1:8547',
      maxTriggerAgeMs: integer(env.BACKRUN_MAX_TRIGGER_AGE_MS || 8000,'BACKRUN_MAX_TRIGGER_AGE_MS',100,60000),
      simulationTimeoutMs: integer(env.BACKRUN_SIMULATION_TIMEOUT_MS || 8000,'BACKRUN_SIMULATION_TIMEOUT_MS',100,60000),
      maxSimulationAgeMs: integer(env.BACKRUN_MAX_SIMULATION_AGE_MS || 1500,'BACKRUN_MAX_SIMULATION_AGE_MS',100,10000),
      maxPending: integer(env.BACKRUN_MAX_PENDING || 64,'BACKRUN_MAX_PENDING',1,2048),
      latencyBudgetMs: integer(env.BACKRUN_LATENCY_BUDGET_MS || 2500,'BACKRUN_LATENCY_BUDGET_MS',100,10000),
      benchmarkPath: env.BACKRUN_BENCHMARK_PATH || 'runtime/backrun/benchmark.json',
      replayProofPath: env.BACKRUN_REPLAY_PROOF_PATH || 'runtime/backrun/replay-proof.json',
      commissioningPath: env.BACKRUN_COMMISSIONING_PATH || 'runtime/backrun/commissioning.json',
    },
  };
  if (env.DEFAULT_CHAIN && env.DEFAULT_CHAIN !== 'ethereum') throw new Error('Production profile supports Ethereum only');
  if(!['true','false'].includes(String(env.BACKRUN_ENABLED||'false').toLowerCase()))throw new Error('BACKRUN_ENABLED must be true or false');
  for (const symbol of [...profile.tokenSymbols,...profile.borrowSymbols,...(profile.backrun.enabled?profile.backrun.borrowSymbols:[])]) if (!tokens[symbol] || !profile.tokenSymbols.includes(symbol)) throw new Error(`Unknown/unscanned token ${symbol}`);
  if(!profile.backrun.borrowSymbols.length||new Set(profile.backrun.borrowSymbols).size!==profile.backrun.borrowSymbols.length)throw new Error('Distinct backrun settlement tokens required');
  if (!['adaptive','capital','flashloan'].includes(profile.backrun.fundingMode)) throw new Error('BACKRUN_FUNDING_MODE must be adaptive, capital or flashloan');
  if (!['disabled','public_pending','mev_share','custom'].includes(profile.backrun.orderflowSource)) throw new Error('Unsupported BACKRUN_ORDERFLOW_SOURCE');
  if (profile.backrun.enabled) {
    for (const symbol of profile.backrun.borrowSymbols) {
      if (!profile.backrun.minimumProfitBySymbol[symbol]) throw new Error(`BACKRUN_MIN_PROFIT_${symbol} required when BACKRUN_ENABLED=true`);
      if (!profile.backrun.maxAmountBySymbol[symbol]) throw new Error(`BACKRUN_MAX_AMOUNT_${symbol} required when BACKRUN_ENABLED=true`);
    }
    if (profile.backrun.orderflowSource==='mev_share' && new URL(profile.backrun.mevShareStreamUrl).protocol!=='https:') throw new Error('BACKRUN_MEV_SHARE_STREAM_URL must use HTTPS');
    if (profile.backrun.orderflowSource==='mev_share' && new URL(profile.backrun.mevShareRelayUrl).protocol!=='https:') throw new Error('BACKRUN_MEV_SHARE_RELAY_URL must use HTTPS');
    if(profile.backrun.orderflowSource==='disabled')throw new Error('Enabled backrun requires an order-flow source');
    require('../backrun/forkBackend').assertLocalForkUrl(profile.backrun.forkRpcUrl);
  }
  for (const url of profile.relays) if (new URL(url).protocol !== 'https:') throw new Error('Private relay must use HTTPS');
  profile.fingerprint = utils.keccak256(utils.toUtf8Bytes(JSON.stringify(serialize(profile))));
  return Object.freeze(profile);
}
module.exports = { productionProfile };
