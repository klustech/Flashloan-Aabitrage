const {Contract,utils}=require('ethers');
const {bn,address}=require('./units');
async function accountReceipt({provider,contract,receipt,record,nativeToBorrow}) {
  const block=await provider.getBlock(receipt.blockNumber);
  if(!block||block.hash!==receipt.blockHash)throw new Error('Receipt block changed');
  const actualGasCostNative=bn(receipt.gasUsed).mul(receipt.effectiveGasPrice);
  const builderPaymentNative=bn(receipt.gasUsed).mul(bn(receipt.effectiveGasPrice).sub(block.baseFeePerGas));
  let realizedGrossProfit=bn(0);
  if(receipt.status===1){
    let found=false;for(const log of receipt.logs){if(address(log.address)!==address(contract.address))continue;let event;try{event=contract.interface.parseLog(log);}catch(_){continue;}if(event.name==='ProfitWithdrawn'&&address(event.args.token)===address(record.borrowToken)&&address(event.args.recipient)===address(record.profitRecipient)){realizedGrossProfit=realizedGrossProfit.add(event.args.amount);found=true;}}
    if(!found)throw new Error('Missing executor profit settlement event');
  }
  const token=new Contract(record.borrowToken,['function balanceOf(address) view returns(uint256)'],provider);
  const [before,after]=await Promise.all([token.balanceOf(record.profitRecipient,{blockTag:receipt.blockNumber-1}),token.balanceOf(record.profitRecipient,{blockTag:receipt.blockNumber})]);
  const gasCostBorrowToken=await nativeToBorrow(actualGasCostNative,receipt.blockNumber);
  const realizedNetProfit=realizedGrossProfit.sub(gasCostBorrowToken);
  const grossNative=address(record.borrowToken)===address(record.weth)?realizedGrossProfit:await record.borrowToNative(realizedGrossProfit,receipt.blockNumber);
  return {status:receipt.status===1?'INCLUDED':'REVERTED',txHash:receipt.transactionHash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,actualGasUsed:receipt.gasUsed,effectiveGasPrice:receipt.effectiveGasPrice,actualGasCostNative,builderPaymentNative,
    profitRecipientBalanceChange:bn(after).sub(before),realizedGrossProfit,realizedNetProfit,realizedNetNative:bn(grossNative).sub(actualGasCostNative),predictionError:realizedNetProfit.sub(record.economics.expectedNetProfit),gasValuation:'exact-output borrow-token-to-WETH at receipt block; includes priority fee once'};
}
module.exports={accountReceipt};
