const { randomUUID } = require("crypto");
const { TriggerIntake } = require("./triggerIntake");
const { decodeTriggerHint } = require("./triggerDecoder");
const { BackrunLedger } = require("./backrunLedger");
const { BackrunEvidence } = require("./evidence");
const { checkSignal, abortError } = require("../bot/asyncControl");
const { bn, serialize } = require("../bot/units");
const {safeReason}=require("./errors");
function percentile(values, p) {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
}
class BackrunService {
  constructor({ coordinator, profile = coordinator.profile, engine, backend, execution, source, ledger, evidence, emit = () => {} }) {
    Object.assign(this, { coordinator, profile, engine, backend, execution, source, emit });
    this.intake = new TriggerIntake({ maxPending: profile.backrun.maxPending || 64 });
    this.ledger = ledger || new BackrunLedger({ persist: async row => {
      const db = require("../dbClient");
      if (db.isDbEnabled()) await db.upsertBackrun(row);
      else if (process.env.NODE_ENV === "production") throw new Error("Backrun database unavailable");
    } });
    this.evidence = evidence || new BackrunEvidence(profile);
    this.latencies = []; this.queue = []; this.errors = []; this.closed = true; this.processing = false;
    this.stats = { received: 0, decoded: 0, processed: 0, rejected: 0, simulations: 0, profitable: 0, predictionFailures: 0,
      funding: { CAPITAL: 0, FLASH_LOAN: 0 }, expectedByToken: {}, dexPairs: {}, reasons: {}, lastTriggerAt: null };
    this.onHint = hint => this.ingest(hint).catch(() => this.trip("backrun_persistence_or_ingress_failed"));
    this.onSourceError = () => {
      this.errors.push(Date.now()); this.errors = this.errors.filter(t => t > Date.now() - 60000);
      if (this.errors.length >= 30) this.trip("orderflow_source_circuit_breaker");
    };
  }
  enabled() { return Boolean(this.profile.backrun.enabled); }
  async start() {
    if (!this.enabled() || !this.closed) return this;
    if (!this.source) throw new Error("Configured backrun source unavailable");
    await this.backend.verify();
    const db = require("../dbClient"); await db.waitForPoolReady();
    if (process.env.NODE_ENV === "production" && !db.isDbEnabled()) throw new Error("Backrun DB required");
    if (db.isDbEnabled()) for (const row of (await db.getBackruns(2000)).reverse()) this.ledger.remember(row);
    await this.recoverAfterRestart();
    this.closed = false; this.circuitReason = null;
    this.source.on("hint", this.onHint); this.source.on("source_error", this.onSourceError); this.source.start();
    this.timer = setInterval(() => {
      try {
        const c = this.coordinator, state = c.state.snapshot();
        this.evidence.heartbeat({ healthy: !this.closed && !this.circuitReason && this.source.status().connected &&
          Boolean(c.marketCache.head) && Date.now() - this.lastHeadAt < 30000 &&
          (process.env.NODE_ENV !== "production" || db.isDbEnabled()),
          paper: state.state === "PAPER",
          signatures: this.execution.activity.signatures + c.execution.activity.signatures,
          submissions: this.execution.activity.submissions + c.execution.activity.submissions });
      } catch (_) { this.trip("backrun_evidence_persistence_failed"); }
    }, 5000); this.timer.unref?.(); return this;
  }
  headChanged(block) {
    this.lastHeadAt = Date.now();
    if (this.headHash && this.headHash !== block.hash) this.active?.abort();
    this.headHash = block.hash;
  }
  stop() {
    this.closed = true; this.active?.abort(); clearInterval(this.timer);
    this.source?.removeListener("hint", this.onHint); this.source?.removeListener("source_error", this.onSourceError);
    this.source?.stop();
    const discarded=this.queue;this.queue=[];
    for(const item of discarded){this.intake.take(item.trigger.hash);this.reject(item.row,"orderflow_observer_stopped").catch(()=>{});}
  }
  trip(reason) { this.circuitReason = reason; this.stop(); if (this.coordinator.state.state === "LIVE_RUNNING") this.coordinator.state.pause(reason); }
  reason(reason) { this.stats.rejected++; this.stats.reasons[reason] = (this.stats.reasons[reason] || 0) + 1; }
  async ingest(hint) {
    this.stats.received++; this.stats.lastTriggerAt = Date.now();
    if (!this.enabled() || this.closed) return { accepted: false, reason: "backrun_disabled_or_stopped" };
    const c = this.coordinator;
    if (!["PAPER", "LIVE_RUNNING"].includes(c.state.state)) return { accepted: false, reason: "trading_stopped_or_paused" };
    const trigger = decodeTriggerHint(hint, c.poolRegistry);
    if (!trigger.usable) { this.reason(trigger.reason); return { accepted: false, reason: trigger.reason }; }
    this.stats.decoded++;
    if (!this.intake.push(trigger)) return { accepted: false, reason: "duplicate_trigger" };
    const id = randomUUID(), row = await this.ledger.write({ id, triggerHash: trigger.hash, triggerSource: trigger.source || "unknown",
      triggerReceivedAt: trigger.receivedAt, affectedPools: trigger.affectedPools, predictionMode: trigger.predictionMode,
      mode: c.state.snapshot().mode, status: "DETECTED" });
    this.queue.push({ trigger, row });
    while (this.queue.length > this.intake.maxPending) {
      const dropped = this.queue.shift(); this.intake.take(dropped.trigger.hash);
      await this.reject(dropped.row, "pending_queue_saturated");
    }
    if (!this.processing) this.drain().catch(() => this.trip("backrun_processing_failed"));
    return { accepted: true, id };
  }
  async reject(row, reason) {
    this.reason(reason);
    const saved = await this.ledger.write({ ...row, status: "REJECTED", rejectionReason: reason });
    this.emit("backrun_rejected", saved); return saved;
  }
  async drain() {
    this.processing = true;
    try {
      while (!this.closed && this.queue.length) {
        const item = this.queue.shift();
        try { await this.process(item); }
        finally { this.intake.take(item.trigger.hash); }
      }
    } finally { this.processing = false; }
  }
  async process({ trigger, row }) {
    const c = this.coordinator, controller = new AbortController(), signal = controller.signal;
    this.active = controller;
    const timer = setTimeout(() => controller.abort(), this.profile.backrun.simulationTimeoutMs);
    let saved = row, started = Date.now(), locked = false, executed = null;
    try {
      if (!["PAPER", "LIVE_RUNNING"].includes(c.state.state)) throw abortError("Trading stopped");
      if (Date.now() - trigger.receivedAt > this.profile.backrun.maxTriggerAgeMs) throw abortError("Trigger expired in queue");
      if (c.busy || c.backrunBusy || c.ledger.pending().length) throw new Error("Canonical scanner or execution busy");
      if (!c.marketCache.head || !c.poolRegistry.values().length) throw new Error("Canonical pool cache not ready");
      c.backrunBusy = true; locked = true;
      const revision = c.state.revision, block = await c.provider.getBlock("latest");
      if (block.hash !== c.marketCache.head.hash) throw abortError("Canonical cache parent mismatch");
      // A MEV-Share hint hash is a matchmaker double hash: it cannot be looked up
      // on chain. The bundle references it and only lands if the trigger does.
      if (trigger.rawTx) {
        const freshTrigger = await c.provider.getTransaction(trigger.hash);
        if (freshTrigger?.blockNumber != null) throw abortError("Trigger already landed");
      }
      saved = await this.ledger.write({ ...saved, parentBlock: block.number, parentHash: block.hash, targetBlock: block.number + 1 });
      await this.engine.inspect({ trigger, registry: c.poolRegistry, block, signal }, async ({ opportunities, rejections, context, stages }) => {
        for (const r of rejections) this.reason(r.reason);
        if (!opportunities.length) throw new Error("No viable exact post-trigger route");
        const best = opportunities[0]; best.executionId = randomUUID();
        saved = await this.ledger.write({ ...saved, status: "POST_TRIGGER_QUOTED", candidateId: best.route.id, route: best.route,
          borrowToken: best.route.borrowToken, token: c.tokens.get(best.route.borrowToken), inputAmount: best.quote.borrowAmount,
          grossProfit: best.grossProfit, contextId: context.id, affectedPools: [...context.changedPools], stages });
        saved = await this.ledger.write({ ...saved, status: "FUNDING_SELECTED", fundingMode: best.funding.mode,
          funding: best.funding, fundingComparisons:best.fundingComparisons, economics: best.economics, capitalAvailable: best.funding.capitalAvailable,
          flashPremium: best.funding.flashFee, gasEstimate: best.transaction.gasLimit, builderAllowance: best.tip.builderPaymentNativeWei });
        const simulationStarted = Date.now(); this.stats.simulations++;
        const sim = await this.backend.simulateUnsignedBundle({ trigger, parent: block, header: context.header, transaction: best.transaction, signal });
        checkSignal(signal);
        if ((await c.provider.getBlock("latest")).hash !== block.hash || revision !== c.state.revision)
          throw abortError("Backrun parent/mode changed during simulation");
        if (Date.now() - trigger.receivedAt > this.profile.backrun.maxTriggerAgeMs) throw abortError("Trigger expired before decision");
        const logs = sim.backrunReceipt.logs.filter(log=>log.address.toLowerCase()===c.contract.address.toLowerCase()).map(log => {
          try { return c.contract.interface.parseLog(log); } catch (_) { return null; }
        }).filter(Boolean);
        const profit = logs.filter(log => log.name === "ProfitWithdrawn" &&
          log.args.token.toLowerCase() === best.route.borrowToken && log.args.recipient.toLowerCase() === this.profile.expectedProfitRecipient?.toLowerCase())
          .reduce((s, log) => s.add(log.args.amount), bn(0));
        if (profit.lt(best.economics.minimumRequiredProfit.add(best.costBudgetBorrow)))
          throw new Error("Ordered bundle settlement does not meet profit floor");
        saved = await this.ledger.write({ ...saved, status: "SIMULATED", latencyMs: Date.now() - trigger.receivedAt,
          stages: { ...stages, quoteSizePrepareMs: simulationStarted - started - context.predictionMs, bundleSimulationMs: Date.now() - simulationStarted },
          simulation: { ordered: true, kind: sim.kind, signed: false, submitted: false, gasUsed: sim.gasUsed,
            triggerGasUsed: sim.triggerGasUsed, parentHash: sim.parentHash, simulatedAt: sim.simulatedAt,
            realizedProfitOnFork: profit, relaySimulation: false } });
        this.stats.profitable++; this.stats.funding[best.funding.mode]++;
        const symbol = c.tokens.get(best.route.borrowToken).symbol;
        this.stats.expectedByToken[symbol] = bn(this.stats.expectedByToken[symbol] || 0).add(best.economics.expectedNetProfit).toString();
        const pair = best.route.legs.map(l => l.dex).join(" → "); this.stats.dexPairs[pair] = (this.stats.dexPairs[pair] || 0) + 1;
        this.evidence.record(saved); this.emit("backrun_simulated", saved);
        if (c.state.state === "LIVE_RUNNING") {
          const result = await this.execution.execute({ ...best, simulation: sim }, { signal, revision });
          executed = result.status;
          saved = await this.ledger.write({ ...saved, status: result.status, txHash: result.txHash, executionId: best.executionId });
        }
      });
      this.stats.processed++;
    } catch (error) {
      // A transaction the engine reports as sent is uncertain even if our own
      // journal write afterwards failed: never reject it, stop and reconcile.
      if (["SUBMITTED", "INCLUDED", "REVERTED"].includes(saved.status) || ["SUBMITTED", "INCLUDED", "REVERTED"].includes(executed) ||
        c.ledger.pending().length) {
        this.trip("backrun_submission_uncertain");
      } else {
        try { await this.reject(saved, safeReason(error)); }
        catch (_) { this.trip("backrun_persistence_or_ingress_failed"); }
      }
      if (/mismatch|Mixed pre-trigger|settlement/.test(error.message)) {
        this.stats.predictionFailures++; this.trip("backrun_prediction_or_relay_mismatch");
      }
    } finally {
      clearTimeout(timer); this.active = null;
      if (locked) c.backrunBusy = false;
      this.latencies.push(Date.now() - trigger.receivedAt); this.latencies = this.latencies.slice(-2000);
    }
  }
  status() {
    return serialize({ enabled: this.enabled(), running: !this.closed, processing: this.processing,
      orderflowSource: this.profile.backrun.orderflowSource, source: this.source?.status(), circuitReason: this.circuitReason,
      ...this.stats, intake: this.intake.snapshot(), engine: this.engine.status(),
      latency: { samples: this.latencies.length, medianMs: percentile(this.latencies, .5), p95Ms: percentile(this.latencies, .95) },
      activity: this.execution.activity, burnIn: this.evidence.report(), recent: this.ledger.recent(20) });
  }
  // Pre-submission rows cannot resume after a restart: the trigger, parent and
  // fork state are gone. A SIMULATED row whose LIVE execution reached the
  // coordinator ledger as sent is linked to it instead, so receipt
  // reconciliation settles it rather than losing a possibly-included trade.
  async recoverAfterRestart() {
    const sent = [...(this.coordinator.ledger.records?.values?.() || [])].filter(r => r.strategy === "TRANSACTION_TRIGGERED_BACKRUN" &&
      ["SUBMITTED", "INCLUDED", "REVERTED", "DROPPED"].includes(r.status));
    const recovered = { expired: 0, linked: 0 };
    for (const row of this.ledger.recent(2000)) {
      if (["DETECTED", "POST_TRIGGER_QUOTED", "FUNDING_SELECTED"].includes(row.status)) {
        await this.reject(row, "ephemeral_trigger_expired_on_restart"); recovered.expired++;
      } else if (row.status === "SIMULATED") {
        const linked = sent.find(r => r.triggerHash?.toLowerCase() === row.triggerHash?.toLowerCase());
        if (linked) { await this.ledger.write({ ...row, status: "SUBMITTED", executionId: linked.id, txHash: linked.txHash }); recovered.linked++; }
        else { await this.reject(row, "ephemeral_trigger_expired_on_restart"); recovered.expired++; }
      }
    }
    await this.reconcile();
    return recovered;
  }
  async reconcile(){
    for(const row of this.ledger.recent(2000)){
      if(row.status!=="SUBMITTED"||!row.executionId)continue;
      const settled=this.coordinator.ledger.records.get(row.executionId);
      if(settled&&["INCLUDED","REVERTED","DROPPED"].includes(settled.status))
        await this.ledger.write({...row,status:settled.status,receiptAccounting:settled});
    }
  }
}
module.exports = { BackrunService, percentile };
