const {Wallet}=require('ethers');
const {FlashbotsBundleProvider}=require('@flashbots/ethers-provider-bundle');

class PrivateRelays {
  constructor(provider,urls,authKey){
    this.provider=provider;
    this.urls=urls;
    this.authSigner=authKey?new Wallet(authKey):Wallet.createRandom();
    this.providers=new Map();
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
      const relay=await this.get(url);
      return {url,relay,simulation:await relay.simulate(txs,targetBlock,stateBlock)};
    }));
    return results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  }

  async submit(approved,bundle,targetBlock,guard){
    const txs=this.normalizeBundle(bundle),results=[];
    for(const item of approved){
      await guard();
      const response=await item.relay.sendRawBundle(txs,targetBlock);
      if(!response.error)results.push({url:item.url,bundleHash:response.bundleHash});
    }
    if(!results.length)throw new Error('No simulated private relay accepted bundle');
    return results;
  }
}

module.exports={PrivateRelays};
