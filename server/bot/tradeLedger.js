const fs=require('fs');
const path=require('path');
const {serialize,bn}=require('./units');
const STATUS=new Set(['DISCOVERED','SIMULATED','SUBMITTED','INCLUDED','REVERTED','DROPPED']);
const ALLOWED={DISCOVERED:['SIMULATED','DROPPED'],SIMULATED:['SUBMITTED','DROPPED'],SUBMITTED:['INCLUDED','REVERTED','DROPPED'],INCLUDED:[],REVERTED:[],DROPPED:[]};
// Every write appends JSON plus a newline and fsyncs before it is
// acknowledged. A final line without its newline is a write that crashed
// mid-append and was never acknowledged: skip it. Corruption anywhere else
// is not a torn write and must stop startup.
function readJournal(text,stats={}){
  const lines=text.split('\n');
  if(!text.endsWith('\n')&&lines[lines.length-1]!==''){lines.pop();stats.tornWrites=(stats.tornWrites||0)+1;}
  return lines.filter(Boolean).map(line=>JSON.parse(line));
}
class TradeLedger {
  constructor({file=path.resolve(process.env.EXECUTION_LEDGER_PATH||'runtime/executions.jsonl'),persist}={}){
    this.file=file;this.persist=persist;this.records=new Map();
    this.tornWrites=0;
    if(file&&fs.existsSync(file))for(const row of readJournal(fs.readFileSync(file,'utf8'),this))this.records.set(row.id,row);
  }
  async write(record){
    const previous=this.records.get(record.id);if(!STATUS.has(record.status))throw new Error('Unknown trade status');
    if(previous&&previous.status!==record.status&&!ALLOWED[previous.status]?.includes(record.status))throw new Error('Invalid trade lifecycle');
    const row=serialize({...previous,...record,updatedAt:Date.now()});
    // Database persistence succeeds before the durable local journal. Refuse
    // signing/submission if either storage write fails.
    if(this.persist)await this.persist(row);
    if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const fd=fs.openSync(this.file,'a',0o600);try{fs.writeSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    this.records.set(row.id,row);return row;
  }
  recent(limit=100){return [...this.records.values()].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,limit);}
  // LIVE intent is written as SUBMITTED before any relay call, so a LIVE
  // DISCOVERED/SIMULATED record found at startup was never sent. PAPER rows
  // are evidence and stay as recorded.
  async expireUnsubmitted(reason='restarted_before_submission'){
    const expired=[];
    for(const r of [...this.records.values()])if(r.mode==='LIVE'&&['DISCOVERED','SIMULATED'].includes(r.status))
      expired.push(await this.write({...r,status:'DROPPED',reason}));
    return expired;
  }
  pending(){return this.recent(Number.MAX_SAFE_INTEGER).filter(r=>r.mode==='LIVE'&&r.status==='SUBMITTED');}
  dailyLossNative(now=Date.now()){return this.recent(Number.MAX_SAFE_INTEGER).filter(r=>r.mode==='LIVE'&&r.updatedAt>now-86400000&&r.realizedNetNative).reduce((sum,r)=>{const p=bn(r.realizedNetNative);return p.lt(0)?sum.sub(p):sum;},bn(0));}
  summary(){
    const groups={};const errors={};const reasons={};
    for(const r of this.records.values()){
      if(r.reason)reasons[r.reason]=(reasons[r.reason]||0)+1;
      if(!r.borrowToken)continue;const key=r.borrowToken;
      const group=groups[key]||(groups[key]={token:r.token,borrowToken:key,expectedPaperNet:bn(0),realizedNet:bn(0),realizedGasNative:bn(0),included:0,reverted:0});
      if(r.mode==='PAPER'&&r.status==='SIMULATED')group.expectedPaperNet=group.expectedPaperNet.add(r.economics.expectedNetProfit);
      if(r.mode==='LIVE'&&['INCLUDED','REVERTED'].includes(r.status)&&r.realizedNetProfit!==undefined){group.realizedNet=group.realizedNet.add(r.realizedNetProfit);group.realizedGasNative=group.realizedGasNative.add(r.actualGasCostNative);group[r.status==='INCLUDED'?'included':'reverted']++;if(r.predictionError!==undefined)(errors[key]||(errors[key]=[])).push(bn(r.predictionError));}
    }
    const accuracy={};for(const [key,values] of Object.entries(errors)){values.sort((a,b)=>a.lt(b)?-1:1);accuracy[key]={samples:values.length,mean:values.reduce((s,v)=>s.add(v),bn(0)).div(values.length),median:values[Math.floor(values.length/2)],p95:values[Math.min(values.length-1,Math.ceil(values.length*.95)-1)]};}
    return serialize({tokens:groups,accuracy,rejectionReasons:reasons,total:this.records.size,pending:this.pending().length});
  }
}
module.exports={TradeLedger,readJournal};
