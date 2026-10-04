const assert = require("assert/strict");
const { randomUUID } = require("crypto");
async function main() {
  const db = require("../server/dbClient"), id = randomUUID(), benchmarkId = randomUUID();
  const record = { id, triggerHash:"0x"+"01".repeat(32),triggerSource:"custom",mode:"PAPER",status:"DETECTED",
    inputAmount:"1234567890123456789012345678901234567890",parentBlock:26115901,targetBlock:26115902 };
  try {
    await db.upsertBackrun(record);
    await db.upsertBackrun({...record,status:"SIMULATED"});
    const saved=(await db.getBackruns()).find(r=>r.id===id);
    assert.equal(saved.status,"SIMULATED");assert.equal(saved.inputAmount,record.inputAmount);
    await db.insertBackrunBenchmark({id:benchmarkId,profileFingerprint:"test",netNative:record.inputAmount});
    const result=await db.pool.query("SELECT payload FROM backrun_benchmarks WHERE id=$1",[benchmarkId]);
    assert.equal(result.rows[0].payload.netNative,record.inputAmount);
    console.log("Backrun records and independent benchmark base-unit precision verified");
  } finally {
    if(db.pool){await db.pool.query("DELETE FROM backrun_records WHERE id=$1",[id]);
      await db.pool.query("DELETE FROM backrun_benchmarks WHERE id=$1",[benchmarkId]);await db.pool.end();}
  }
}
if(require.main===module)main().catch(()=>{console.error("Backrun persistence check failed");process.exitCode=1;});
module.exports={main};
