const fs=require("fs");
const {environment,save}=require("./backrun-context");
const {evidenceFingerprint}=require("../server/backrun/readiness");
const {EXECUTOR_VERSION}=require("../server/config/executorVersion");
function read(file){return JSON.parse(fs.readFileSync(file,"utf8"));}
function buildReport(profile,{replay,benchmark,paper,capitalForkProof,flashForkProof,riskReview,localValidation,projection},now=Date.now()){
  const fingerprint=evidenceFingerprint(profile),checks=[];
  const check=(name,passed)=>checks.push({name,passed:Boolean(passed)});
  for(const [name,value] of Object.entries({replay,benchmark,paper,capitalForkProof,flashForkProof}))
    check(name+" configuration",value?.profileFingerprint===fingerprint);
  check("Canonical intra-block transition",replay?.passed&&replay.intraBlock&&replay.canonicalReceiptsVerified);
  check("Seven-day complete historical economics",benchmark?.passed&&benchmark.durationMs>=7*86400000&&
    benchmark.coverageComplete&&benchmark.sameBlockBundleVerified&&benchmark.distinctProfitableTriggers>=2&&benchmark.fullExecutorSimulations);
  check("Continuous recent PAPER evidence",paper?.passed&&paper.continuousMs>=7*86400000&&paper.profitable>0&&
    paper.signatures===0&&paper.submissions===0&&now-paper.lastHeartbeat<=30000);
  check("Capital fork execution",capitalForkProof?.passed&&capitalForkProof.mode==="CAPITAL"&&capitalForkProof.executorVersion===EXECUTOR_VERSION);
  check("Flash fork execution",flashForkProof?.passed&&flashForkProof.mode==="FLASH_LOAN"&&flashForkProof.executorVersion===EXECUTOR_VERSION);
  check("Local validation passed for this code and profile",localValidation?.kind==="BACKRUN_LOCAL_VALIDATION"&&
    localValidation.localValidationPassed&&localValidation.readyForPaper&&localValidation.profileFingerprint===fingerprint&&
    localValidation.executorVersion===EXECUTOR_VERSION);
  const minimumFrequency=Number(riskReview?.minimumOpportunitiesPerDay);
  const minimumNet=riskReview?.minimumNetNativePerDay;
  check("Explicit economic risk review",riskReview?.reviewed===true&&riskReview.profileFingerprint===fingerprint&&
    Number.isFinite(minimumFrequency)&&minimumFrequency>0&&minimumNet&&Number(minimumNet)>0&&riskReview.capitalPlan&&riskReview.drawdownPlan&&riskReview.competitionAssumptions);
  check("Measured decision latency",benchmark?.latency?.p95Ms>0&&benchmark.latency.p95Ms<=profile.backrun.latencyBudgetMs);
  check("Economic frequency",benchmark?.opportunityFrequencyPerDay>=minimumFrequency);
  let netPass=false;
  try{netPass=require("../server/bot/units").bn(benchmark.netNative).mul(86400000).div(benchmark.durationMs).gte(minimumNet);}catch(_){}
  check("Net after infrastructure allowance",netPass);
  // §26: projected retained net (after capture, inclusion, builder and gas
  // assumptions) must exceed infrastructure cost plus the risk margin.
  check("Projected retained net covers infrastructure and risk margin",projection?.economicallyReady===true&&
    projection.profileFingerprint===fingerprint);
  const economicNames=["Explicit economic risk review","Measured decision latency","Economic frequency","Net after infrastructure allowance",
    "Projected retained net covers infrastructure and risk margin"];
  return {profileFingerprint:fingerprint,createdAt:now,checks,passed:checks.every(c=>c.passed),replay,benchmark,paper,capitalForkProof,flashForkProof,
    localValidation:localValidation?{createdAt:localValidation.createdAt,gitCommit:localValidation.gitCommit,manifestId:localValidation.manifestId}:null,
    economicAcceptance:{passed:checks.filter(c=>economicNames.includes(c.name)).every(c=>c.passed),riskReview,projection:projection||null}};
}
// Bound to the running code and profile; no age limit here because PAPER
// itself runs for at least seven days after validation.
function localValidation(profile){
  const {buildManifest}=require("../server/backrun/validation/validationEvidence");
  const {localValidationStatus}=require("../server/backrun/validation/acceptance");
  const status=localValidationStatus({manifest:buildManifest(profile),maxAgeMs:0});
  return status.ok?status.report:null;
}
const projectionPath=()=>process.env.BACKRUN_PROJECTION_PATH||"runtime/backrun/economic-projection.json";
async function main(){
  const {profile}=environment();
  // The evidence module's own report applies the PAPER-passed definition.
  const {BackrunEvidence}=require("../server/backrun/evidence");
  const paper=new BackrunEvidence(profile,{file:process.env.BACKRUN_BURN_IN_PATH||"runtime/backrun/burn-in.json"}).report();
  const report=buildReport(profile,{replay:read(profile.backrun.replayProofPath),benchmark:read(profile.backrun.benchmarkPath),paper,
    capitalForkProof:read(process.env.BACKRUN_CAPITAL_FORK_PROOF_PATH||"runtime/backrun/capital-fork-proof.json"),
    flashForkProof:read(process.env.BACKRUN_FLASH_FORK_PROOF_PATH||"runtime/backrun/flash-fork-proof.json"),
    riskReview:read(process.env.BACKRUN_RISK_REVIEW_PATH||"runtime/backrun/risk-review.json"),localValidation:localValidation(profile),
    projection:fs.existsSync(projectionPath())?read(projectionPath()):null});
  save(profile.backrun.commissioningPath,report);console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error("Required backrun evidence missing; report not issued.");process.exitCode=1;});
module.exports={main,buildReport};
