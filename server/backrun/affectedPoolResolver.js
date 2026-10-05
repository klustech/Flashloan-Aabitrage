const { CandidateIndex } = require("../bot/opportunityEngine");
const { address } = require("../bot/units");
class AffectedPoolResolver {
  constructor({ profile, maxCandidates = 32, index = new CandidateIndex() }) {
    Object.assign(this, { profile, maxCandidates, index });
  }
  resolve(registry, changedPools, block) {
    const tokens = this.profile.backrun.borrowSymbols.map(s => address(this.profile.tokens[s]));
    const affected = new Set(changedPools.map(address));
    const ranked = this.index.candidates(registry, tokens, block, [...affected]);
    const priority = new Map(tokens.map((t, i) => [t, i]));
    const routes = ranked.filter(r => r.legs.some(l => affected.has(l.poolAddress)));
    routes.sort((a, b) => (priority.get(a.borrowToken) - priority.get(b.borrowToken)) ||
      (this.index.attempts.get(a.id) || 0) - (this.index.attempts.get(b.id) || 0));
    const selected = routes.slice(0, this.maxCandidates);
    for (const r of selected) this.index.markScreened(r.id);
    return selected;
  }
}
module.exports = { AffectedPoolResolver };
