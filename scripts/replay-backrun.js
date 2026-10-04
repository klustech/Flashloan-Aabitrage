const fs = require("fs");
const path = require("path");
const { HistoricalReplay } = require("../server/backrun/historicalReplay");
const { evidenceFingerprint } = require("../server/backrun/readiness");
const { environment, topologyContext, routeFromFixture, save, QuoteEngine } = require("./backrun-context");
const { replayDiagnostic } = require("./backrun-replay-diagnostics");
async function main({ progress = () => {} } = {}) {
  progress({ stage: "configuration" });
  const { profile, archive, backend } = environment({ onArchiveRetry: event => progress({ stage: "archive_retry", ...event }),
    onMiningProgress: progress });
  progress({ stage: "archive_chain_id" });
  if (Number(await archive.send("eth_chainId", [])) !== 1) throw new Error("Mainnet archive required");
  progress({ stage: "fork_identity" });
  const identity = await backend.verify();
  progress({ stage: "fork_identity_verified", ...identity });
  progress({ stage: "fixture" });
  const fixturePath = process.argv.slice(2).find(arg => !["--local", "--anvil"].includes(arg));
  const fixture = JSON.parse(fs.readFileSync(fixturePath || path.join(__dirname, "../test/fixtures/backrun-26115902.json"), "utf8"));
  const replay = new HistoricalReplay({ archive, backend, progress });
  const report = await replay.caseStudy(fixture, async ({ provider, block }) => {
    const context = await topologyContext(profile, provider, block.number,fixture.routePools);
    const route = routeFromFixture(fixture, context, profile, block.number), quoter = new QuoteEngine(context.adapters);
    quoter.beginBlock(block.hash);
    return (await quoter.quoteRoute(route, fixture.amountIn, block.number)).expectedFinalAmount;
  });
  progress({ stage: "save_proof" });
  report.profileFingerprint = evidenceFingerprint(profile);
  save(profile.backrun.replayProofPath, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
async function cli() {
  let context = { stage: "configuration" };
  const progress = event => {
    if (["mining_started", "mining_wait", "mining_complete"].includes(event.stage)) {
      console.log(JSON.stringify({ kind: "BACKRUN_REPLAY_MINING", ...event }));
      return; // Preserve canonical stage/index in the failure context.
    }
    if (event.stage === "archive_retry") {
      console.log(JSON.stringify({ kind: "BACKRUN_ARCHIVE_RETRY", ...event }));
      return;
    }
    context = event;
    if (["signed_transaction", "canonical_receipt"].includes(event.stage)) {
      if (event.stage !== "signed_transaction" || event.transactionIndex % 50 !== 0) return;
    }
    console.log(JSON.stringify({ kind: "BACKRUN_REPLAY_PROGRESS", ...event }));
  };
  try {
    if (process.argv.includes("--local")) {
      const { backend, forkEngine } = environment();
      await require("./backrun-local-fork").withLocalFork({ backrun: { forkRpcUrl: backend.url } }, () => main({ progress }), progress, { engine: forkEngine });
    } else await main({ progress });
  } catch (error) {
    console.error(JSON.stringify(replayDiagnostic(error, context), null, 2));
    process.exitCode = 1;
  }
}
if (require.main === module) cli();
module.exports = { main, cli };
