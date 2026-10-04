function encodeExecutorCall(contract,data,fundingMode){
  if(!contract?.interface)throw new Error('executor contract required');
  if(fundingMode==='CAPITAL')
    return contract.interface.encodeFunctionData('executeCapitalArbitrage',[data]);
  if(fundingMode==='FLASH_LOAN')
    return contract.interface.encodeFunctionData('initiateFlashLoan',[data]);
  throw new Error('Unsupported funding mode');
}

function buildExecutorTransaction({contract,from,data,fundingMode,gasLimit,maxFeePerGas,maxPriorityFeePerGas}){
  const tx={
    to:contract.address,
    from,
    data:encodeExecutorCall(contract,data,fundingMode),
  };
  if(gasLimit!==undefined)tx.gasLimit=gasLimit;
  if(maxFeePerGas!==undefined)tx.maxFeePerGas=maxFeePerGas;
  if(maxPriorityFeePerGas!==undefined)tx.maxPriorityFeePerGas=maxPriorityFeePerGas;
  return tx;
}

module.exports={encodeExecutorCall,buildExecutorTransaction};
