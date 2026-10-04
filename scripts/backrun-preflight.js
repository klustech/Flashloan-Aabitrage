const { environment } = require("./backrun-context");
const { preflight } = require("./paper-preflight");
async function main() {
  const { profile, backend } = environment();
  const report=await preflight();
  const check=async(name,work)=>{try{await work();report.checks.push({name,passed:true});}catch(_){report.checks.push({name,passed:false});report.ready=false;}};
  await check("Backrun enabled",async()=>{if(!profile.backrun.enabled)throw new Error();});
  await check("Dedicated chain-1 fork backend",()=>backend.verify());
  await check("Backrun schema",async()=>{
    const db=require("../server/dbClient");
    try {
      await db.waitForPoolReady();await db.getBackruns(1);
      await db.pool.query("SELECT id,payload FROM backrun_benchmarks LIMIT 0");
      const rows=await db.pool.query("SELECT COUNT(*)::integer AS total FROM backrun_records WHERE mode='LIVE'");
      if(rows.rows[0].total)throw new Error("Dedicated PAPER database required");
    } finally { await db.pool.end(); }
  });
  console.log(JSON.stringify(report,null,2));if(!report.ready)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error("Backrun preflight failed");process.exitCode=1;});
module.exports={main};
