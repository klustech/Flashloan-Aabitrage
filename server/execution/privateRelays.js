const {Wallet}=require('ethers');
const {FlashbotsBundleProvider}=require('@flashbots/ethers-provider-bundle');

// RELAY_AUTH_PRIVATE_KEY only signs X-Flashbots-Signature headers. Relays and
// builders key searcher reputation to that address, so it must persist across
// restarts. It must never hold funds and must never equal the execution signer
// (PRIVATE_KEY), which signs the funded backrun transaction itself.
// FLASHBOTS_AUTH_KEY is accepted as a legacy alias.
function relayAuthKey(env=process.env){
  return (env.RELAY_AUTH_PRIVATE_KEY||env.FLASHBOTS_AUTH_KEY||'').trim();
}

function resolveRelayAuthSigner({env=process.env,authKey=relayAuthKey(env),executionAddress}={}){
  const key=typeof authKey==='string'?authKey.trim():authKey;
  const signer=key?new Wallet(key):Wallet.createRandom();
  const execution=executionAddress||(env.PRIVATE_KEY?.trim()?new Wallet(env.PRIVATE_KEY.trim()).address:null);
  if(execution&&signer.address.toLowerCase()===execution.toLowerCase())
    throw new Error('Relay auth key must differ from the execution signer');
  return {signer,persistent:Boolean(key)};
}

function emptyStats(){
  return {simulations:0,simulationErrors:0,simulationLatencyMs:null,validated:0,rejected:0,
    submissions:0,submissionErrors:0,submissionLatencyMs:null,included:0,reverted:0,dropped:0,
    lastError:null,lastErrorAt:null,lastSubmittedAt:null};
}

class PrivateRelays {
  constructor(provider,urls,authKey,{executionAddress,env=process.env}={}){
    this.provider=provider;
    this.urls=urls;
    const identity=resolveRelayAuthSigner({env,authKey:authKey===undefined?relayAuthKey(env):authKey,executionAddress});
    this.authSigner=identity.signer;
    this.persistentIdentity=identity.persistent;
    this.providers=new Map();
    this.stats=new Map(urls.map(url=>[url,emptyStats()]));
  }

  identity(){return {address:this.authSigner.address,persistent:this.persistentIdentity};}

  stat(url){if(!this.stats.has(url))this.stats.set(url,emptyStats());return this.stats.get(url);}

  fail(url,field,error){
    const s=this.stat(url);s[field]++;
    s.lastError=String(error?.message||error).slice(0,200);s.lastErrorAt=Date.now();
  }

  // Exponential moving average keeps per-relay latency bounded in memory.
  latency(url,field,startedAt){
    const s=this.stat(url),ms=Date.now()-startedAt;
    s[field]=s[field]===null?ms:Math.round(s[field]*0.8+ms*0.2);
  }

  async get(url){
    if(!this.providers.has(url))
      this.providers.set(url,await FlashbotsBundleProvider.create(this.provider,this.authSigner,url));
    return this.providers.get(url);
  }

  normalizeBundle(bundle){
    const txs=Array.isArray(bundle)?bundle:[bundle];
    if(!txs.length||txs.some(tx=>typeof tx!=='string'||!tx.startsWith('0x')))
      throw new Error('Signed raw bundle transactions required');
    return txs;
  }

  async simulate(bundle,targetBlock,stateBlock){
    const txs=this.normalizeBundle(bundle);
    const results=await Promise.allSettled(this.urls.map(async url=>{
      const startedAt=Date.now();
      try{
        const relay=await this.get(url);
        const simulation=await relay.simulate(txs,targetBlock,stateBlock);
        this.stat(url).simulations++;this.latency(url,'simulationLatencyMs',startedAt);
        if(simulation?.error)this.fail(url,'simulationErrors',simulation.error.message||simulation.error);
        return {url,relay,simulation};
      }catch(error){this.fail(url,'simulationErrors',error);throw error;}
    }));
    return results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  }

  // Engines call this after their own ordered-bundle validation so that
  // per-relay acceptance reflects our checks, not just a non-error response.
  recordValidation(url,ok){this.stat(url)[ok?'validated':'rejected']++;}

  async submit(approved,bundle,targetBlock,guard){
    const txs=this.normalizeBundle(bundle),results=[];
    for(const item of approved){
      await guard();
      const startedAt=Date.now();
      let response;
      try{response=await item.relay.sendRawBundle(txs,targetBlock);}
      catch(error){this.fail(item.url,'submissionErrors',error);continue;}
      this.latency(item.url,'submissionLatencyMs',startedAt);
      if(response.error){this.fail(item.url,'submissionErrors',response.error.message||response.error);continue;}
      const s=this.stat(item.url);s.submissions++;s.lastSubmittedAt=Date.now();
      results.push({url:item.url,bundleHash:response.bundleHash});
    }
    if(!results.length)throw new Error('No simulated private relay accepted bundle');
    return results;
  }

  // A settled bundle is credited to every relay that accepted it; relays do
  // not reveal which one's builder actually won the block.
  recordOutcome(submissions,status){
    const field={INCLUDED:'included',REVERTED:'reverted',DROPPED:'dropped'}[status];
    if(!field||!Array.isArray(submissions))return;
    for(const url of new Set(submissions.map(s=>s?.url).filter(Boolean)))this.stat(url)[field]++;
  }

  status(){
    return {identity:this.identity(),
      relays:Object.fromEntries([...this.stats].map(([url,s])=>[url,{...s,
        acceptanceRate:s.simulations?s.validated/s.simulations:null,
        inclusionRate:s.submissions?s.included/s.submissions:null}]))};
  }
}

module.exports={PrivateRelays,resolveRelayAuthSigner,relayAuthKey};
