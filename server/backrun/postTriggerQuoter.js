const { bn, address } = require("../bot/units");
const { edge } = require("../market/poolRegistry");
class PostTriggerQuoter {
  constructor(context, profile) { Object.assign(this, { context, profile }); }
  async quote(route, amount, signal) {
    this.context.assertActive();
    if (route.legs.some(l => l.predictionContext !== this.context.id))
      throw new Error("Mixed pre-trigger/post-trigger pool state");
    const result = await this.context.quoter.quoteRoute(route, amount, this.context.simulationBlock, signal);
    this.context.assertActive();
    return { ...result, stateBlock: this.context.parentBlock, contextId: this.context.id,
      triggerHash: this.context.triggerHash, parentHash: this.context.parentHash,
      simulatedAtBlock: this.context.simulationBlock };
  }
  async nativeCost(token, amount, signal) {
    this.context.assertActive();
    if (address(token) === address(this.profile.tokens.WETH)) return bn(amount);
    const pool = this.context.registry.values().find(p => p.dex === "uniswap_v2" &&
      [p.token0, p.token1].includes(address(token)) && [p.token0, p.token1].includes(address(this.profile.tokens.WETH)));
    if (!pool) throw new Error("Missing exact post-trigger gas valuation pool");
    // Exact output asks how many settlement tokens buy the required native gas.
    return this.context.quoter.quoteLeg(edge(pool, token), amount, this.context.simulationBlock, "output", signal);
  }
  async toNative(token, amount, signal) {
    if (address(token) === address(this.profile.tokens.WETH)) return bn(amount);
    const pool = this.context.registry.values().find(p => p.dex === "uniswap_v2" &&
      [p.token0, p.token1].includes(address(token)) && [p.token0, p.token1].includes(address(this.profile.tokens.WETH)));
    if (!pool) throw new Error("Missing post-trigger native valuation pool");
    return this.context.quoter.quoteLeg(edge(pool, token), amount, this.context.simulationBlock, "input", signal);
  }
}
module.exports = { PostTriggerQuoter };
