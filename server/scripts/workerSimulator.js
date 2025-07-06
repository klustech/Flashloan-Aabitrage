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
const { buildStepsFromHops } = require("../../utils/buildStepsFromHops");

function isValidRoute(route) {
  return (
    route &&
    Array.isArray(route.hops) &&
    route.hops.length > 0 &&
    typeof route.id === "string"
  );
}

(async () => {
  try {
    if (!isValidRoute(workerData.route)) {
      throw new Error("Invalid route structure (missing or empty hops array)");
    }

    // Compile executable steps *inside* the worker
    buildStepsFromHops(workerData.route);

    if (
      !Array.isArray(workerData.route.steps) ||
      workerData.route.steps.length === 0
    ) {
      throw new Error("buildStepsFromHops produced no steps");
    }

    const rawOut = simulateRoute(workerData.route, workerData.amountIn);

    /* ---------------------------------------------
       Always return a 18-dec BigNumber *string*
       --------------------------------------------- */
    const { ethers, BigNumber } = require("ethers");
    const outBN = BigNumber.isBigNumber(rawOut)
      ? rawOut
      : ethers.utils.parseUnits(rawOut.toString(), 18); // 99.1026 → 9910… wei

    parentPort.postMessage({
      routeId: workerData.route.id,
      result: outBN.toString(), // safe to Structured-Clone
    });
  } catch (err) {
    parentPort.postMessage({
      routeId: workerData.route?.id ?? "unknown",
      error: err.stack ?? err.message,
    });
  }
})();
