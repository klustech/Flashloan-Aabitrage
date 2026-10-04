const { loadEnvironment } = require("./paper-preflight");
async function smoke({baseUrl,apiKey,fetch=globalThis.fetch,timeoutMs=30000,intervalMs=1000,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const url=new URL(baseUrl);
  if(!["http:","https:"].includes(url.protocol)||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!apiKey)throw new Error("Loopback authenticated API required");
  async function get(path){
    const response=await fetch(new URL(path,url),{headers:{"x-api-key":apiKey},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error("Backrun API unavailable");return response.json();
  }
  let initial;
  const started=now();
  while(now()-started<timeoutMs){
    const [trading,backrun,health]=await Promise.all([get("/api/trading"),get("/api/backrun/status"),get("/api/trading/paper-health")]);
    if(trading.trading?.state!=="PAPER"||!trading.safety?.paperOnly||trading.safety.hasPrivateKey||
      trading.safety.activity.signatures||trading.safety.activity.submissions)throw new Error("Unsigned PAPER invariants failed");
    if(!backrun.enabled||!backrun.running||!backrun.source?.connected||backrun.circuitReason||
      backrun.activity.signatures||backrun.activity.submissions||!health.database||!health.runtimeWritable||
      health.chainId!==1)throw new Error("Backrun observer health failed");
    initial??={block:health.block,received:backrun.received};
    if(health.block>initial.block&&backrun.received>initial.received)return {passed:true,observedTriggers:backrun.received-initial.received,
      blockAdvance:health.block-initial.block,profitable:backrun.profitable,signatures:0,submissions:0};
    await wait(intervalMs);
  }
  throw new Error("No advancing chain/order-flow activity within smoke window");
}
async function main(){loadEnvironment();if(process.env.PRIVATE_KEY)throw new Error("PAPER refuses private key");
  const report=await smoke({baseUrl:process.env.PAPER_API_URL||"http://127.0.0.1:3001",apiKey:process.env.API_KEY,timeoutMs:60000});
  console.log(JSON.stringify(report,null,2));}
if(require.main===module)main().catch(()=>{console.error("Backrun smoke failed; no commissioning evidence issued.");process.exitCode=1;});
module.exports={main,smoke};
