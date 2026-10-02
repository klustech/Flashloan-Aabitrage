const {utils}=require('ethers');
const {bn,serialize}=require('./units');
const {executionGuard}=require('../risk/executionGuard');
const {validateBundleSimulation}=require('../execution/flashbots');
const {accountReceipt}=require('./receiptAccounting');
class ExecutionEngine {
  constructor(context){Object.assign(this,context);}
  async settle(record,receipt){
    const result=await accountReceipt({provider:this.provider,contract:this.contract,receipt,record:{...record,borrowToNative:(amount,block)=>this.converter(record.borrowToken).toNative(amount,block)},nativeToBorrow:(amount,block)=>this.converter(record.borrowToken).toBorrow(amount,block)});
    const settled=await this.ledger.write({...record,...result});this.emit('trade_executed',settled);return settled;
  }
  async reconcile(){
    const head=await this.provider.getBlockNumber();
    for(const record of this.ledger.pending()){
      const receipt=await this.provider.getTransactionReceipt(record.txHash);
      if(receipt && head-receipt.blockNumber+1>=this.profile.confirmations)await this.settle(record,receipt);
      else if(!receipt && head>record.targetBlock+this.profile.confirmations)await this.ledger.write({...record,status:'DROPPED',reason:'private_bundle_not_included'});
    }
    return this.ledger.pending().length;
  }
  async execute(prepared,{signal,revision}){
    let record=prepared.record;
    const guard=async()=>{
      if(!this.state.canSign(revision))throw new Error('LIVE stopped/disarmed during validation');
      const head=await this.provider.getBlock('latest');
      if(head.hash!==prepared.block.hash)throw new Error('Chain state advanced/reorganized');
      executionGuard({route:prepared.quote.route,quote:prepared.quote,economics:prepared.economics,profile:this.profile,head:head.number,signal});
      if (typeof this.provider.getBalance === 'function' && (await this.provider.getBalance(this.wallet?.address||this.profile.operatorAddress)).lt(bn(prepared.transaction.gasLimit).mul(prepared.tip.maxFeePerGas))) throw new Error('Insufficient signer ETH for gas');
      if(await this.contract.paused())throw new Error('Contract paused');
      if(this.ledger.dailyLossNative().gte(utils.parseEther(this.profile.maxDailyLossNative)))throw new Error('Daily loss limit reached');
      if(this.ledger.pending().length)throw new Error('Pending submission must settle first');
    };
    await guard();
    if(!this.wallet)throw new Error('Missing LIVE signer');
    const nonce=await this.provider.getTransactionCount(this.wallet.address,'pending');
    const signedTx=await this.wallet.signTransaction({...prepared.transaction,nonce,chainId:this.profile.chainId,type:2});
    await guard();
    const simulations=await this.relays.simulate(signedTx,prepared.block.number+1,prepared.block.number);
    const approved=[];
    for(const item of simulations){try{
      const validation=validateBundleSimulation(item.simulation,{signedTx,stateBlock:prepared.block.number,maxGasUnits:prepared.transaction.gasLimit});
      const economics=await this.calculateEconomics(prepared.quote,validation.gasUsed,prepared.tip,prepared.terms,prepared.block.number);
      executionGuard({route:prepared.quote.route,quote:prepared.quote,economics,profile:this.profile,head:prepared.block.number,signal});
      if(validation.gasUsed.gt(prepared.transaction.gasLimit))throw new Error('Simulation gas exceeds signed limit');
      approved.push({...item,validation,economics});
    }catch(err){this.emit('bundle_rejected',{id:record.id,relay:item.url,reason:err.message});}}
    if(!approved.length)throw new Error('No successful profitable private bundle simulation');
    await guard();
    const txHash=utils.keccak256(signedTx),targetBlock=prepared.block.number+1;
    record=await this.ledger.write({...record,status:'SIMULATED',simulation:{callStatic:true,bundle:true,relays:approved.map(s=>s.url),gasUsed:approved.map(s=>s.validation.gasUsed)},economics:prepared.economics,txHash,targetBlock,nonce});
    // Persist intent before the network call, so a crash/timeout cannot lead to
    // reusing the same nonce or treating a potentially submitted tx as idle.
    record=await this.ledger.write({...record,status:'SUBMITTED'});
    const synchronousGuard=()=>{if(!this.state.canSign(revision)||signal?.aborted||Date.now()-prepared.quote.quotedAt>this.profile.maxQuoteAgeMs)throw new Error('Submission disarmed/expired');};
    const submissions=await this.relays.submit(approved,signedTx,targetBlock,synchronousGuard);
    record=await this.ledger.write({...record,submissions});this.emit('trade_submitted',record);
    const receipt=await this.provider.waitForTransaction(txHash,this.profile.confirmations,45000).catch(()=>null);
    if(receipt){const settled=await this.settle(record,receipt);return {executed:settled.status==='INCLUDED',estimatedProfitInDai:prepared.economics.expectedNetProfit,realizedNetProfit:bn(settled.realizedNetProfit),trade:serialize(settled)};}
    return {executed:false,status:'SUBMITTED',txHash,reason:'receipt_pending'};
  }
}
module.exports={ExecutionEngine};
