const { TriggerIntake } = require("./triggerIntake");
const { decodeTriggerHint } = require("./triggerDecoder");

class BackrunService {
  constructor({ profile, registryProvider, engine, emit = () => {} }) {
    Object.assign(this, { profile, registryProvider, engine, emit });
    this.intake = new TriggerIntake({ maxPending: Number(profile.backrun?.maxPending || 2048) });
    this.stats = { hints: 0, unusable: 0, processed: 0, opportunities: 0, errors: 0 };
  }

  enabled() {
    return Boolean(this.profile.backrun?.enabled);
  }

  async ingest(hint, { block, signal } = {}) {
    this.stats.hints++;
    if (!this.enabled()) return { accepted: false, reason: "backrun_disabled" };
    const registry = await this.registryProvider();
    const trigger = decodeTriggerHint(hint, registry);
    if (!trigger.usable) {
      this.stats.unusable++;
      return { accepted: false, reason: trigger.reason };
    }
    if (!this.intake.push(trigger)) return { accepted: false, reason: "duplicate_trigger" };

    try {
      const opportunities = await this.engine.inspect({ trigger, registry, block, signal });
      this.intake.take(trigger.hash);
      this.stats.processed++;
      this.stats.opportunities += opportunities.length;
      for (const opportunity of opportunities) this.emit("backrun_opportunity", opportunity);
      return { accepted: true, trigger, opportunities };
    } catch (error) {
      this.stats.errors++;
      this.intake.take(trigger.hash);
      throw error;
    }
  }

  status() {
    return {
      enabled: this.enabled(),
      orderflowSource: this.profile.backrun?.orderflowSource,
      ...this.stats,
      intake: this.intake.snapshot(),
      engine: this.engine.status(),
    };
  }
}

module.exports = { BackrunService };
