require('dotenv').config();
const {spawnSync}=require('child_process');
const fs=require('fs');
if(!process.env.MAINNET_RPC_URL||!process.env.FORK_BLOCK_NUMBER){console.error('MAINNET_RPC_URL and a fixed FORK_BLOCK_NUMBER are required for the real fork proof');process.exit(1);}
const output=process.env.FORK_PROOF_PATH||'runtime/fork-proof.json';
if(fs.existsSync(output))fs.unlinkSync(output);
const run=spawnSync(process.execPath,[require.resolve('hardhat/internal/cli/cli'),'test','test/integration/productionForkProof.test.js'],{stdio:'inherit',env:{...process.env,ENABLE_MAINNET_FORK:'true'}});
if(run.status!==0||!fs.existsSync(output)){process.exit(run.status||1);}
if(!JSON.parse(fs.readFileSync(output,'utf8')).passed)process.exit(1);
