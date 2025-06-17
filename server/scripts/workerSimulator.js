// server/scripts/workerSimulator.js
const { parentPort, workerData } = require("worker_threads");
const { simulateRoute } = require("../../utils/profitDetermination");

// workerData: { route, amountIn }
try {
  const result = simulateRoute(workerData.route, workerData.amountIn);
  parentPort.postMessage({ routeId: workerData.route.id, result });
} catch (error) {
  parentPort.postMessage({
    routeId: workerData.route.id,
    error: error.message,
  });
}
