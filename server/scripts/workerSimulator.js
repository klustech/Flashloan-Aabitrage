/**
 *  server/scripts/workerSimulator.js
 *
 *  A tiny wrapper that runs simulateRoute() inside a worker thread.
 *  Now includes:
 *    • structural guard – refuse payloads with missing/empty hops
 *    • full-stack error propagation for easier debugging
 */

const { parentPort, workerData } = require("worker_threads");
const { simulateRoute } = require("../../utils/profitDetermination");

function isValidRoute(route) {
  return (
    route &&
    Array.isArray(route.hops) &&
    route.hops.length > 0 /* already checked */ &&
    Array.isArray(route.steps) &&
    route.steps.length > 0 /* new guard */ &&
    typeof route.id === "string"
  );
}

(async () => {
  try {
    if (!isValidRoute(workerData.route)) {
      throw new Error("Invalid route structure (missing or empty hops array)");
    }

    const result = simulateRoute(workerData.route, workerData.amountIn);
    parentPort.postMessage({ routeId: workerData.route.id, result });
  } catch (err) {
    parentPort.postMessage({
      routeId: workerData.route?.id ?? "unknown",
      error: err.stack ?? err.message,
    });
  }
})();
