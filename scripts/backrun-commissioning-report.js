const fs=require("fs");
const {environment,save}=require("./backrun-context");
const {evidenceFingerprint}=require("../server/backrun/readiness");
function read(file){return JSON.parse(fs.readFileSync(file,"utf8"));}
function buildReport(profile,{replay,benchmark,paper,capitalForkProof,flashForkProof,riskReview},now=Date.now()){
  const fingerprint=evidenceFingerprint(profile),checks=[];
  const check=(name,passed)=>checks.push({name,passed:Boolean(passed)});
  for(const [name,value] of Object.entries({replay,benchmark,paper,capitalForkProof,flashForkProof}))
    check(name+" configuration",value?.profileFingerprint===fingerprint);
  check("Canonical intra-block transition",replay?.passed&&replay.intraBlock&&replay.canonicalReceiptsVerified);
  check("Seven-day complete historical economics",benchmark?.passed&&benchmark.durationMs>=7*86400000&&
    benchmark.coverageComplete&&benchmark.sameBlockBundleVerified&&benchmark.distinctProfitableTriggers>=2&&benchmark.fullExecutorSimulations);
  check("Continuous recent PAPER evidence",paper?.passed&&paper.continuousMs>=7*86400000&&paper.profitable>0&&
    paper.signatures===0&&paper.submissions===0&&now-paper.lastHeartbeat<=30000);
  check("Capital fork execution",capitalForkProof?.passed&&capitalForkProof.mode==="CAPITAL"&&capitalForkProof.executorVersion===3);
  check("Flash fork execution",flashForkProof?.passed&&flashForkProof.mode==="FLASH_LOAN"&&flashForkProof.executorVersion===3);
  const minimumFrequency=Number(riskReview?.minimumOpportunitiesPerDay);
  const minimumNet=riskReview?.minimumNetNativePerDay;
  check("Explicit economic risk review",riskReview?.reviewed===true&&riskReview.profileFingerprint===fingerprint&&
    Number.isFinite(minimumFrequency)&&minimumFrequency>0&&minimumNet&&Number(minimumNet)>0&&riskReview.capitalPlan&&riskReview.drawdownPlan&&riskReview.competitionAssumptions);
  check("Measured decision latency",benchmark?.latency?.p95Ms>0&&benchmark.latency.p95Ms<=profile.backrun.latencyBudgetMs);
  check("Economic frequency",benchmark?.opportunityFrequencyPerDay>=minimumFrequency);
  let netPass=false;
  try{netPass=require("../server/bot/units").bn(benchmark.netNative).mul(86400000).div(benchmark.durationMs).gte(minimumNet);}catch(_){}
  check("Net after infrastructure allowance",netPass);
  return {profileFingerprint:fingerprint,createdAt:now,checks,passed:checks.every(c=>c.passed),replay,benchmark,paper,capitalForkProof,flashForkProof,
    economicAcceptance:{passed:checks.slice(-4).every(c=>c.passed),riskReview}};
}
async function main(){
  const {profile}=environment();
  const paper=read(process.env.BACKRUN_BURN_IN_PATH||"runtime/backrun/burn-in.json");
  paper.passed=paper.continuousMs>=7*86400000&&paper.profitable>0&&!paper.signatures&&!paper.submissions;
  const report=buildReport(profile,{replay:read(profile.backrun.replayProofPath),benchmark:read(profile.backrun.benchmarkPath),paper,
    capitalForkProof:read(process.env.BACKRUN_CAPITAL_FORK_PROOF_PATH||"runtime/backrun/capital-fork-proof.json"),
    flashForkProof:read(process.env.BACKRUN_FLASH_FORK_PROOF_PATH||"runtime/backrun/flash-fork-proof.json"),
    riskReview:read(process.env.BACKRUN_RISK_REVIEW_PATH||"runtime/backrun/risk-review.json")});
  save(profile.backrun.commissioningPath,report);console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error("Required backrun evidence missing; report not issued.");process.exitCode=1;});
module.exports={main,buildReport};
