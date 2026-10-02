const {providers}=require('ethers');
function createProvider(env=process.env){
  const urls=[env.MAINNET_RPC_URL,...(env.RPC_BACKUP_URLS||'').split(',')].filter(Boolean);
  if(!urls.length)throw new Error('MAINNET_RPC_URL required');
  return new providers.FallbackProvider(urls.map((url,i)=>({provider:new providers.JsonRpcProvider({url,timeout:15000}),priority:i+1,stallTimeout:1500,weight:1})),1);
}
async function pinnedBlock(provider){const block=await provider.getBlock('latest');if(!block?.hash||!block.baseFeePerGas)throw new Error('Missing latest EIP-1559 block');return block;}
module.exports={createProvider,pinnedBlock};
