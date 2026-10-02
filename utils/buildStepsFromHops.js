const { BigNumber } = require("ethers");

/**
 * buildStepsFromHops(route)
 *
 * Simple compiler that converts route.hops into executable
 * simulation steps expected by simulateRoute(). Each step
 * applies the hop's feeBps to the input amount. No pricing
 * model is used here — we assume 1:1 swap before fees.
 *
 * @param {Object} route - Route object with .hops array
 * @returns {Object} The same route with .steps array added
 */
function buildStepsFromHops(route) {
  if (!route || !Array.isArray(route.hops)) return route;

  route.steps = route.hops.map((hop, idx) => {
    const feeFraction = (hop?.feeBps ?? 30) / 10000;
    return {
      description: `hop${idx + 1}:${hop.dex}`,
      simulate: (amt) => {
        // amt may be a BigNumber or a number
        const feeFactor = 1 - feeFraction;
        if (BigNumber.isBigNumber(amt)) {
          return amt.mul(Math.floor(feeFactor * 1e6)).div(1e6);
        }
        return amt * feeFactor;
      },
    };
  });

  return route;
}

module.exports = { buildStepsFromHops };

