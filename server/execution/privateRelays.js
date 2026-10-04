const {Wallet}=require('ethers');
const {FlashbotsBundleProvider}=require('@flashbots/ethers-provider-bundle');
class PrivateRelays {
  constructor(provider,urls,authKey){this.provider=provider;this.urls=urls;this.authSigner=authKey?new Wallet(authKey):Wallet.createRandom();this.providers=new Map();}
  async get(url){if(!this.providers.has(url))this.providers.set(url,await FlashbotsBundleProvider.create(this.provider,this.authSigner,url));return this.providers.get(url);}
  async simulateBundle(signedTxs,targetBlock,stateBlock){
    if(!Array.isArray(signedTxs)||!signedTxs.length)throw new Error('Signed transaction bundle required');
    const results=await Promise.allSettled(this.urls.map(async url=>{const relay=await this.get(url);return {url,relay,simulation:await relay.simulate(signedTxs,targetBlock,stateBlock)};}));
    return results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  }
  async submitBundle(approved,signedTxs,targetBlock,guard){
    if(!Array.isArray(signedTxs)||!signedTxs.length)throw new Error('Signed transaction bundle required');
    const results=[];
    for(const item of approved){guard();const response=await item.relay.sendRawBundle(signedTxs,targetBlock);if(!response.error)results.push({url:item.url,bundleHash:response.bundleHash});}
    if(!results.length)throw new Error('No simulated private relay accepted bundle');return results;
  }
  simulate(signedTx,targetBlock,stateBlock){return this.simulateBundle([signedTx],targetBlock,stateBlock);}
  submit(approved,signedTx,targetBlock,guard){return this.submitBundle(approved,[signedTx],targetBlock,guard);}
}
module.exports={PrivateRelays};
