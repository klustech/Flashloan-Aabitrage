/**
 * server/scripts/priceIngestion.js
 *
 * Stubbed version: Multicall and on-chain subscriptions are disabled.
 * - initSubscriptions(pools) does nothing.
 * - fetchMulticallReservesForRoute(route) does nothing.
 * If you need real-time on-chain data later, re-introduce Multicall logic.
 */

const reserveCache = new Map();

/**
 * initSubscriptions:
 *   (Originally subscribed to on-chain pool “Sync” events via WebSocket. Stubbed out.)
 *
 * @param {string[]} pools  – List of pool addresses to subscribe to (ignored).
 */
async function initSubscriptions(pools) {
  // Stub: do nothing.
  return;
}

/**
 * fetchMulticallReservesForRoute:
 *   (Originally used @makerdao/multicall to batch-fetch reserves. Stubbed out.)
 *
 * @param {Object} routeOrPoolInfo – Route or pool details (ignored).
 */
async function fetchMulticallReservesForRoute(routeOrPoolInfo) {
  // Stub: do nothing.
  return;
}

module.exports = {
  initSubscriptions,
  reserveCache,
  fetchMulticallReservesForRoute,
};
