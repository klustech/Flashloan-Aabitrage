const { address, bn } = require("../bot/units");
const { scanTwoLeg, scanTriangles } = require("../scripts/crossDexScanner");

function routeTouches(route, affected) {
  return route.legs.some(leg => affected.has(address(leg.poolAddress)));
}

class BackrunEngine {
  constructor({ profile, fundingEngine, evaluatePostTrigger, maxCandidates = 32 }) {
    if (typeof evaluatePostTrigger !== "function")
      throw new Error("evaluatePostTrigger adapter required");
    Object.assign(this, { profile, fundingEngine, evaluatePostTrigger, maxCandidates });
    this.stats = { triggers: 0, routes: 0, evaluated: 0, viable: 0, rejected: 0 };
  }

  borrowTokens() {
    const symbols = this.profile.backrun?.borrowSymbols || ["WETH", "DAI", "USDC"];
    return symbols
      .filter(symbol => this.profile.tokens[symbol])
      .map(symbol => address(this.profile.tokens[symbol]));
  }

  candidateRoutes(registry, trigger, blockNumber) {
    const affected = new Set((trigger.affectedPools || []).map(address));
    if (!affected.size) return [];
    const edges = registry.edges();
    const routes = [
      ...scanTwoLeg(edges, this.borrowTokens(), blockNumber),
      ...scanTriangles(edges, this.borrowTokens(), blockNumber),
    ].filter(route => routeTouches(route, affected));

    const priority = new Map(this.borrowTokens().map((token, i) => [token, i]));
    routes.sort((a, b) =>
      (priority.get(address(a.borrowToken)) ?? 999) -
      (priority.get(address(b.borrowToken)) ?? 999)
    );
    return routes.slice(0, this.maxCandidates);
  }

  async inspect({ trigger, registry, block, signal }) {
    this.stats.triggers++;
    const routes = this.candidateRoutes(registry, trigger, block.number);
    this.stats.routes += routes.length;
    const accepted = [];

    for (const route of routes) {
      if (signal?.aborted) {
        const error = new Error("Backrun inspection aborted");
        error.name = "AbortError";
        throw error;
      }
      try {
        this.stats.evaluated++;
        const result = await this.evaluatePostTrigger({ trigger, route, block, signal });
        if (!result || !bn(result.grossProfit).gt(0)) {
          this.stats.rejected++;
          continue;
        }
        const funding = await this.fundingEngine.decide({
          token: route.borrowToken,
          amount: result.borrowAmount,
          grossProfit: result.grossProfit,
          gasCostBorrowToken: result.gasCostBorrowToken,
          builderPaymentBorrowToken: result.builderPaymentBorrowToken,
          terms: result.flashloanTerms,
          blockTag: block.number,
        });
        if (funding.mode === "REJECT") {
          this.stats.rejected++;
          continue;
        }
        accepted.push({ trigger, route, ...result, funding });
        this.stats.viable++;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        this.stats.rejected++;
      }
    }

    accepted.sort((a, b) =>
      bn(a.funding.expectedNetProfit).gt(b.funding.expectedNetProfit) ? -1 : 1
    );
    return accepted;
  }

  status() {
    return { ...this.stats };
  }
}

module.exports = { BackrunEngine, routeTouches };
