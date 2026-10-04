const { utils } = require("ethers");
const { assertLiveAllowed } = require("../config/paperPolicy");
const { executionGuard } = require("../risk/executionGuard");
const { validateBackrunBundleSimulation } = require("../execution/flashbots");
const { validateRaw } = require("./rawTransaction");
const { checkSignal, abortError } = require("../bot/asyncControl");
const { bn } = require("../bot/units");
const {safeReason}=require("./errors");
class BackrunExecutionEngine {
  constructor(context) { Object.assign(this, context); this.activity = { signatures: 0, submissions: 0 }; }
  async execute(prepared, { signal, revision }) {
    assertLiveAllowed(this.profile);
    const triggerTx = validateRaw(prepared.trigger.rawTx, prepared.trigger.hash);
    const guard = async () => {
      assertLiveAllowed(this.profile); checkSignal(signal);
      if (!this.state.canSign(revision)) throw abortError("Backrun disarmed");
      const head = await this.provider.getBlock("latest");
      if (head.hash !== prepared.block.hash) throw abortError("Backrun parent advanced/reorganized");
      if (Date.now() - prepared.trigger.receivedAt > this.profile.backrun.maxTriggerAgeMs) throw abortError("Trigger expired");
      executionGuard({ route: prepared.route, quote: prepared.quote, economics: prepared.economics,
        profile: this.profile, head: head.number, signal });
      const current = await this.provider.getTransaction(prepared.trigger.hash);
      if (!current || current.blockNumber !== null) throw abortError("Trigger disappeared/landed");
      if (await this.provider.getTransactionCount(triggerTx.from, "latest") !== triggerTx.nonce)
        throw abortError("Trigger nonce replaced");
      if (!this.wallet || triggerTx.from === this.wallet.address.toLowerCase()) throw new Error("Independent funded backrun signer required");
      if ((await this.provider.getBalance(this.wallet.address)).lt(bn(prepared.transaction.gasLimit).mul(prepared.tip.maxFeePerGas)))
        throw new Error("Backrun signer gas unavailable");
      if (await this.contract.paused()) throw new Error("Executor paused");
      if (this.ledger.pending().length) throw new Error("Pending submission must settle first");
      if (this.ledger.dailyLossNative().gte(utils.parseEther(this.profile.maxDailyLossNative))) throw new Error("Daily loss limit reached");
      checkSignal(signal); if (!this.state.canSign(revision)) throw abortError("Backrun mode changed");
    };
    await guard();
    const ready = await this.readiness();
    if (!ready.ready) throw new Error("Backrun commissioning incomplete");
    const nonce = await this.provider.getTransactionCount(this.wallet.address, "pending");
    await guard(); assertLiveAllowed(this.profile);
    const signed = await this.wallet.signTransaction({ ...prepared.transaction, nonce, chainId: 1, type: 2 });
    this.activity.signatures++;
    await guard();
    const bundle = [prepared.trigger.rawTx, signed], targetBlock = prepared.block.number + 1;
    const results = await this.relays.simulate(bundle, targetBlock, prepared.block.number), approved = [];
    for (const item of results) {
      try {
        const validation = validateBackrunBundleSimulation(item.simulation, {
          triggerRawTx: bundle[0], backrunSignedTx: signed, stateBlock: prepared.block.number,
          maxGasUnits: prepared.transaction.gasLimit });
        // Economics budget the entire signed gas limit at its maxFee. A
        // successful executor simulation enforces that profit floor on-chain.
        approved.push({ ...item, validation });
      } catch (e) { this.emit("backrun_bundle_rejected", { triggerHash: prepared.trigger.hash, reason: safeReason(e) }); }
    }
    if (!approved.length) throw new Error("No successful ordered private bundle simulation");
    const simulatedAt = Date.now(); await guard();
    const txHash = utils.keccak256(signed), token = this.tokens.get(prepared.route.borrowToken);
    let record = await this.ledger.write({ id: prepared.executionId, status: "DISCOVERED", mode: "LIVE",
      strategy: "TRANSACTION_TRIGGERED_BACKRUN", candidateId: prepared.route.id,
      triggerHash: prepared.trigger.hash, triggerSource: prepared.trigger.source, fundingMode: prepared.funding.mode,
      borrowToken: prepared.route.borrowToken, token, borrowAmount: prepared.quote.borrowAmount, route: prepared.route,
      profileFingerprint: this.profile.fingerprint, economics: prepared.economics, weth: this.profile.tokens.WETH,
      profitRecipient: await this.contract.profitRecipient(), stateBlock: prepared.block.number,
      stateBlockHash: prepared.block.hash, txHash, targetBlock, nonce });
    record = await this.ledger.write({ ...record, status: "SIMULATED",
      simulation: { bundle: true, ordered: true, simulatedAt, relays: approved.map(x => x.url) } });
    await guard();
    record = await this.ledger.write({ ...record, status: "SUBMITTED" });
    this.activity.submissions++;
    const submissions = await this.relays.submit(approved, bundle, targetBlock, async () => {
      await guard();
      if (Date.now() - simulatedAt > this.profile.backrun.maxSimulationAgeMs) throw abortError("Backrun simulation expired");
    });
    await this.ledger.write({ ...record, submissions });
    return { status: "SUBMITTED", txHash, targetBlock, submissions };
  }
}
module.exports = { BackrunExecutionEngine };
