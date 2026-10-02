require('dotenv').config();
const fs=require('fs');
const path=require('path');
const {productionProfile}=require('../server/config/productionProfile');
function buildReport({profile,forkProof,paperBurnIn}){
  if(forkProof.profileFingerprint!==profile.fingerprint||paperBurnIn.profileFingerprint!==profile.fingerprint)throw new Error('Evidence belongs to another deployment/configuration');
  if(!forkProof.passed||!forkProof.txHash||!forkProof.blockNumber)throw new Error('Real mainnet-fork proof missing');
  if(!paperBurnIn.passed||paperBurnIn.continuousMs<7*86400000||paperBurnIn.simulated<1)throw new Error('Continuous seven-day PAPER burn-in incomplete');
  return {profileFingerprint:profile.fingerprint,generatedAt:Date.now(),forkProof,paperBurnIn};
}
function main(){const profile=productionProfile();const report=buildReport({profile,forkProof:JSON.parse(fs.readFileSync(process.env.FORK_PROOF_PATH||'runtime/fork-proof.json')),paperBurnIn:JSON.parse(fs.readFileSync(process.env.PAPER_BURN_IN_PATH||'runtime/paper-burn-in.json'))});const file=process.env.COMMISSIONING_EVIDENCE_PATH||'runtime/commissioning.json';fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(report,null,2),{mode:0o600});console.log('Commissioning evidence complete. Arm LIVE explicitly through the private dashboard.');}
if(require.main===module)try{main();}catch(err){console.error(err.message);process.exitCode=1;}
module.exports={buildReport};
