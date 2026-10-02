const {Wallet}=require('ethers');
const {FlashbotsBundleProvider}=require('@flashbots/ethers-provider-bundle');
class PrivateRelays {
  constructor(provider,urls,authKey){this.provider=provider;this.urls=urls;this.authSigner=authKey?new Wallet(authKey):Wallet.createRandom();this.providers=new Map();}
  async get(url){if(!this.providers.has(url))this.providers.set(url,await FlashbotsBundleProvider.create(this.provider,this.authSigner,url));return this.providers.get(url);}
  async simulate(signedTx,targetBlock,stateBlock){
    const results=await Promise.allSettled(this.urls.map(async url=>{const relay=await this.get(url);return {url,relay,simulation:await relay.simulate([signedTx],targetBlock,stateBlock)};}));
    return results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  }
  async submit(approved,signedTx,targetBlock,guard){
    const results=[];
    for(const item of approved){guard();const response=await item.relay.sendRawBundle([signedTx],targetBlock);if(!response.error)results.push({url:item.url,bundleHash:response.bundleHash});}
    if(!results.length)throw new Error('No simulated private relay accepted bundle');return results;
  }
}
module.exports={PrivateRelays};
