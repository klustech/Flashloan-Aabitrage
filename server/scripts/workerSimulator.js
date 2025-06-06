// server/scripts/workerSimulator.js
const { parentPort, workerData } = require("worker_threads");
const { simulateRoute } = require("./routeFinder");

// workerData: { route, slippageBips }
simulateRoute(workerData.route, workerData.slippageBips)
  .then((result) =>
    parentPort.postMessage({ routeId: workerData.route.id, result })
  )
  .catch((error) =>
    parentPort.postMessage({ routeId: workerData.route.id, error })
  );
