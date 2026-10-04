const { bn, address } = require("../bot/units");
const { scanTwoLeg, scanTriangles } = require("../scripts/crossDexScanner");
const { sizeTrade } = require("../bot/tradeSizer");
const { AffectedPoolResolver } = require("./affectedPoolResolver");
const { PostTriggerQuoter } = require("./postTriggerQuoter");
const { FundingEngine } = require("./fundingEngine");
const { AaveV2 } = require("../flashloan/aaveV2");
const { checkSignal } = require("../bot/asyncControl");
const {safeReason}=require("./errors");
function routeTouches(route, affected) { return route.legs.some(l => affected.has(address(l.poolAddress))); }
class BackrunEngine {
  constructor({ profile, tokens, contract, fundingEngine, evaluatePostTrigger, predictor, builder, maxCandidates = 32 }) {
    Object.assign(this, { profile, tokens, contract, fundingEngine, evaluatePostTrigger, predictor, builder, maxCandidates });
    if (!evaluatePostTrigger && !predictor) throw new Error("evaluatePostTrigger adapter required");
    this.resolver = new AffectedPoolResolver({ profile, maxCandidates });
    this.stats = { triggers: 0, routes: 0, evaluated: 0, viable: 0, rejected: 0, grossPositive: 0, capitalViable: 0, flashViable: 0 };
  }
  borrowTokens() { return (this.profile.backrun?.borrowSymbols || ["WETH", "DAI", "USDC"]).filter(s => this.profile.tokens[s]).map(s => address(this.profile.tokens[s])); }
  candidateRoutes(registry, trigger, number) {
    // Compatibility for the explicit test adapter; production uses the
    // incremental index against the simulated overlay in inspect().
    const affected = new Set((trigger.affectedPools || []).map(address)), edges = registry.edges();
    const priority = new Map(this.borrowTokens().map((t, i) => [t, i]));
    return [...scanTwoLeg(edges, this.borrowTokens(), number), ...scanTriangles(edges, this.borrowTokens(), number)]
      .filter(r => routeTouches(r, affected)).sort((a, b) => priority.get(a.borrowToken) - priority.get(b.borrowToken)).slice(0, this.maxCandidates);
  }
  async inspect({ trigger, registry, block, signal }, consume) {
    this.stats.triggers++;
    if (this.predictor) return this.predictor.withContext({ trigger, registry, block, signal },
      async context => {
        const routes = this.resolver.resolve(context.registry, [...context.changedPools], block.number);
        this.stats.routes += routes.length;
        const post = new PostTriggerQuoter(context, this.profile);
        const flashloan = new AaveV2(context.provider, this.profile.flashloanProvider);
        const funding = new FundingEngine({ provider: context.provider, contract: this.contract, tokens: this.tokens, flashloan, profile: this.profile });
        const accepted = [], rejections = [], termsCache = new Map(), capitalCache = new Map(), positiveRoutes=new Set();
        for (const route of routes) {
          checkSignal(signal);
          try {
            const policy = funding.tokenPolicy(route.borrowToken);
            if (!termsCache.has(route.borrowToken)) termsCache.set(route.borrowToken,
              this.profile.backrun.fundingMode === "capital" ? { premiumBps: null, availableLiquidity: bn(0) } :
                await flashloan.terms(route.borrowToken, context.simulationBlock));
            if(!capitalCache.has(route.borrowToken))capitalCache.set(route.borrowToken,await funding.capitalAvailable(route.borrowToken,context.simulationBlock));
            const terms = termsCache.get(route.borrowToken), capital = capitalCache.get(route.borrowToken);
            const liquidity = bn(terms.availableLiquidity);
            const available = this.profile.backrun.fundingMode === "capital" ? capital :
              this.profile.backrun.fundingMode === "flashloan" ? liquidity : capital.gt(liquidity) ? capital : liquidity;
            const maxInput = policy.maximum.lt(available) ? policy.maximum : available;
            if (maxInput.lte(0)) throw new Error("No funding liquidity");
            const minInput = maxInput.div(1000000).gt(0) ? maxInput.div(1000000) : bn(1);
            const sized = await sizeTrade({ route, minInput, maxInput, premiumBps: 0,
              samples: this.profile.sizingSamples, refinements: this.profile.sizingRefinements, signal,
              extraInputs:[capital.lt(maxInput)?capital:maxInput],
              evaluate: async amount => {
                this.stats.evaluated++;
                const quote = await post.quote(route, amount, signal), grossProfit = quote.expectedFinalAmount.sub(amount);
                if (grossProfit.lte(0)) throw new Error("Post-trigger gross not positive");
                if(!positiveRoutes.has(route.id)){positiveRoutes.add(route.id);this.stats.grossPositive++;}
                const gas = bn(120000 + 130000 * route.legs.length);
                const gasCost = await post.nativeCost(route.borrowToken, gas.mul(block.baseFeePerGas).mul(9).add(7).div(8), signal);
                const decision = await funding.decide({ token: route.borrowToken, amount, grossProfit,
                  gasCostBorrowToken: gasCost, terms, blockTag: context.simulationBlock });
                if (decision.mode === "REJECT") throw new Error(decision.reason);
                return { quote, funding: decision, grossProfit, borrowAmount: amount, flashloanTerms: terms,
                  economics: { expectedNetProfit: decision.expectedNetProfit } };
              } });
            if (!sized) throw new Error("No viable exact post-trigger size");
            const prepared = await this.builder.prepareAdaptive({ ...sized, route, trigger, block }, context, post, signal);
            this.stats.viable++; this.stats[prepared.funding.mode === "CAPITAL" ? "capitalViable" : "flashViable"]++;
            accepted.push(prepared);
          } catch (e) { if (e.name === "AbortError") throw e; this.stats.rejected++; rejections.push({ candidateId: route.id, reason: safeReason(e) }); }
        }
        // Different settlement tokens are not numerically comparable. Rank in
        // native units from the same post-trigger context.
        for (const p of accepted) p.netNative = await post.toNative(p.route.borrowToken, p.economics.expectedNetProfit, signal);
        accepted.sort((a, b) => a.netNative.gt(b.netNative) ? -1 : a.netNative.lt(b.netNative) ? 1 : 0);
        const result = { opportunities: accepted, rejections, context, stages: { predictionMs: context.predictionMs } };
        return consume ? consume(result) : result;
      });
    const accepted = [], routes = this.candidateRoutes(registry, trigger, block.number);
    this.stats.routes += routes.length;
    for (const route of routes) {
      checkSignal(signal);
      try {
        this.stats.evaluated++;
        const result = await this.evaluatePostTrigger({ trigger, route, block, signal });
        if (!result || !bn(result.grossProfit).gt(0)) { this.stats.rejected++; continue; }
        const funding = await this.fundingEngine.decide({ token: route.borrowToken, amount: result.borrowAmount,
          grossProfit: result.grossProfit, gasCostBorrowToken: result.gasCostBorrowToken,
          builderPaymentBorrowToken: result.builderPaymentBorrowToken, terms: result.flashloanTerms, blockTag: block.number });
        if (funding.mode === "REJECT") { this.stats.rejected++; continue; }
        accepted.push({ trigger, route, ...result, funding }); this.stats.viable++;
      } catch (e) { if (e.name === "AbortError") throw e; this.stats.rejected++; }
    }
    return accepted;
  }
  status() { return { ...this.stats, index: this.resolver.index.stats }; }
}
module.exports = { BackrunEngine, routeTouches };
