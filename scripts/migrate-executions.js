require('dotenv').config();
const fs=require('fs');
const path=require('path');
const {Client}=require('pg');
async function main(){const client=new Client({connectionString:process.env.DATABASE_URL,user:process.env.PG_USER,host:process.env.PG_HOST,database:process.env.PG_DB,password:process.env.PG_PASSWORD,port:process.env.PG_PORT});await client.connect();try{await client.query(fs.readFileSync(path.join(__dirname,'../database/migrations/0001_execution_ledger.sql'),'utf8'));console.log('Execution ledger migration applied');}finally{await client.end();}}
if(require.main===module)main().catch(err=>{console.error(err.message);process.exitCode=1;});
module.exports={main};
