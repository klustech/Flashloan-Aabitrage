// Canonical rejection codes (blueprint §23): every reason the pipeline records
// maps to one code, so PAPER evidence answers "why are we not trading?"
// instead of "no opportunity". Rules are ordered; the first match wins.
// Reasons are the categorical strings produced by safeReason(), decoder
// codes and service reasons; nothing here sees raw order flow.
const CODES = Object.freeze([
  "TRIGGER_UNSUPPORTED", "TRIGGER_STALE", "TRIGGER_REPLACED", "STATE_MISMATCH", "NO_AFFECTED_POOL", "NO_ROUTE",
  "NO_POSITIVE_GROSS", "FLASH_LIQUIDITY_LOW", "CAPITAL_LOW", "GAS_TOO_HIGH", "BUILDER_COST_TOO_HIGH", "NET_PROFIT_TOO_LOW",
  "SLIPPAGE_TOO_HIGH", "ROUTER_NOT_APPROVED", "CONTRACT_PAUSED", "SIMULATION_REVERT", "LATENCY_BUDGET_EXCEEDED",
  "RPC_UNHEALTHY", "RELAY_UNAVAILABLE", "RISK_LIMIT",
  // Operational outcomes that are not opportunity rejections.
  "DUPLICATE_TRIGGER", "QUEUE_SATURATED", "TRADING_STOPPED", "UNCLASSIFIED",
]);

const RULES = [
  [/^duplicate_trigger$/, "DUPLICATE_TRIGGER"],
  [/^pending_queue_saturated$/, "QUEUE_SATURATED"],
  [/^(trading_stopped_or_paused|backrun_disabled_or_stopped|orderflow_observer_stopped)$|^Trading stopped|^Backrun (disarmed|mode changed)/, "TRADING_STOPPED"],
  [/^no_tracked_pool_impact_hint$|^simulated_trigger_has_no_tracked_pool_impact$|untracked or ambiguous/, "NO_AFFECTED_POOL"],
  [/^mev_share_hint_|^unsupported_|^raw_trigger_unavailable|Unsupported (router calldata|swap path|signed envelope)|^Raw trigger|^Signed (mainnet trigger|transaction envelope)|Trigger hash does not match|Trigger transaction reverted/, "TRIGGER_UNSUPPORTED"],
  [/nonce replaced|disappeared/, "TRIGGER_REPLACED"],
  [/^Trigger (expired|already landed)|expired_on_restart|^backrun_cancelled_or_expired$|Post-trigger context expired|simulation expired/, "TRIGGER_STALE"],
  [/latency budget/i, "LATENCY_BUDGET_EXCEEDED"],
  [/parent mismatch|parent advanced|parent\/mode changed|Mixed pre-trigger|context mismatch|prediction_or_relay_mismatch/, "STATE_MISMATCH"],
  [/Executor paused/, "CONTRACT_PAUSED"],
  [/router not approved|requires approved routers/i, "ROUTER_NOT_APPROVED"],
  [/^amount_exceeds_backrun_limit$|Daily loss limit|Pending submission must settle|Route outside production scope/, "RISK_LIMIT"],
  [/gas (price )?exceeds ceiling|Gas units exceed ceiling|signer gas unavailable/i, "GAS_TOO_HIGH"],
  [/builder/i, "BUILDER_COST_TOO_HIGH"],
  [/^flashloan_fee_or_liquidity|No funding liquidity|Aave reserve inactive/, "FLASH_LIQUIDITY_LOW"],
  [/^insufficient_capital_or_net_profit$|^insufficient_funding$|^Insufficient capital|^Capital /, "CAPITAL_LOW"],
  [/gross not positive/, "NO_POSITIVE_GROSS"],
  [/slippage|Quote (expired|state is stale)|Pool state missing\/stale/i, "SLIPPAGE_TOO_HIGH"],
  [/^No viable exact post-trigger (route|size)$|^no_economically_viable|No measured funding path is viable/, "NO_ROUTE"],
  [/net below minimum|Net profit below minimum|^Net /, "NET_PROFIT_TOO_LOW"],
  [/reverted|settlement does not meet profit floor|order mismatch|Unexpected net direct coinbase/, "SIMULATION_REVERT"],
  [/relay|private bundle simulation/i, "RELAY_UNAVAILABLE"],
  [/^post_trigger_rpc_or_executor_failed$|Canonical (scanner or execution busy|pool cache not ready)|^Missing |^Fork |^Dedicated |rpc|unavailable/i, "RPC_UNHEALTHY"],
];

function rejectionCode(reason) {
  const text = String(reason || "");
  for (const [pattern, code] of RULES) if (pattern.test(text)) return code;
  return "UNCLASSIFIED";
}

module.exports = { CODES, RULES, rejectionCode };
