const { ForkBackend } = require("./forkBackend");
const { StatePredictor } = require("./statePredictor");
const { BackrunTransactionBuilder } = require("./backrunTransactionBuilder");
const { BackrunEngine } = require("./backrunEngine");
const { BackrunExecutionEngine } = require("./executionEngine");
const { BackrunService } = require("./service");
const { PublicPendingSource } = require("./sources/publicPending");
const { MevShareSource } = require("./sources/mevShare");
const { CustomSource } = require("./sources/custom");
function createBackrunService(c) {
  const { profile } = c;
  const backend = new ForkBackend({ url: profile.backrun.forkRpcUrl,
    archiveUrl: process.env.MAINNET_HTTP_RPC_URL || process.env.MAINNET_RPC_URL });
  const predictor = new StatePredictor({ backend, profile, tokens: c.tokens });
  const builder = new BackrunTransactionBuilder({ contract: c.contract, tokens: c.tokens, profile, operatorAddress: c.operatorAddress });
  const engine = new BackrunEngine({ profile, tokens: c.tokens, contract: c.contract, predictor, builder, maxCandidates: profile.backrun.maxCandidates });
  const execution = new BackrunExecutionEngine({ provider: c.provider, profile, contract: c.contract, wallet: c.wallet,
    tokens: c.tokens, state: c.state, ledger: c.ledger, relays: c.relays, emit: c.emit.bind(c), readiness: c.checkReadiness.bind(c) });
  let source;
  if (profile.backrun.orderflowSource === "public_pending") {
    const url = process.env.MAINNET_WEBSOCKET || process.env.MAINNET_WS_RPC_URL || process.env.MAINNET_WS_URL;
    if (!url || !["ws:", "wss:"].includes(new URL(url).protocol)) throw new Error("Pending transaction WebSocket RPC required");
    source = new PublicPendingSource({ url, provider: c.provider });
  } else if (profile.backrun.orderflowSource === "mev_share")
    source = new MevShareSource({ url: profile.backrun.mevShareStreamUrl });
  else if (profile.backrun.orderflowSource === "custom") source = new CustomSource();
  return new BackrunService({ coordinator: c, engine, backend, execution, source, emit: c.emit.bind(c) });
}
module.exports = { createBackrunService };
