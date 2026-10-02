const assert=require('assert/strict');
const {randomUUID}=require('crypto');
async function main(){const db=require('../server/dbClient');await db.waitForPoolReady();const id=randomUUID();const record={id,mode:'PAPER',status:'DISCOVERED',borrowToken:'0x0000000000000000000000000000000000000001',token:{decimals:6},economics:{expectedNetProfit:'123456789012345678901234567890'}};try{await db.upsertExecution(record);await db.upsertExecution({...record,status:'SIMULATED'});const rows=await db.getExecutions(10),saved=rows.find(r=>r.id===id);assert.equal(saved.status,'SIMULATED');assert.equal(saved.economics.expectedNetProfit,record.economics.expectedNetProfit);console.log('Execution upsert and base-unit precision verified');}finally{if(db.pool){await db.pool.query('DELETE FROM executions WHERE id=$1',[id]);await db.pool.end();}}}
if(require.main===module)main().catch(err=>{console.error(err.message);process.exitCode=1;});
module.exports={main};
