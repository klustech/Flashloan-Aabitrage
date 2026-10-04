const fs = require("fs");
const path = require("path");
const { HistoricalReplay } = require("../server/backrun/historicalReplay");
const { evidenceFingerprint } = require("../server/backrun/readiness");
const { environment, topologyContext, routeFromFixture, save, QuoteEngine } = require("./backrun-context");
async function main() {
  const { profile, archive, backend } = environment();
  if ((await archive.getNetwork()).chainId !== 1) throw new Error("Mainnet archive required");
  const fixture = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, "../test/fixtures/backrun-26115902.json"), "utf8"));
  const replay = new HistoricalReplay({ archive, backend });
  const report = await replay.caseStudy(fixture, async ({ provider, block }) => {
    const context = await topologyContext(profile, provider, block.number,fixture.routePools);
    const route = routeFromFixture(fixture, context, profile, block.number), quoter = new QuoteEngine(context.adapters);
    quoter.beginBlock(block.hash);
    return (await quoter.quoteRoute(route, fixture.amountIn, block.number)).expectedFinalAmount;
  });
  report.profileFingerprint = evidenceFingerprint(profile);
  save(profile.backrun.replayProofPath, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error("Replay failed; check archive support, topology and dedicated fork logs. No proof was issued."); process.exitCode = 1; });
module.exports = { main };
