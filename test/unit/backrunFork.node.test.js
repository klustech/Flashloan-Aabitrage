const test=require("node:test"),assert=require("node:assert/strict"),path=require("path");
const {providers,ContractFactory,Wallet,utils}=require("ethers");
const {ForkBackend,latestBlock}=require("../../server/backrun/forkBackend");
test("isolated fork backend mines trigger+unsigned executor in one block for CAPITAL and FLASH_LOAN",
  {skip:!process.env.LOCAL_BACKRUN_TEST_RPC,timeout:120000},async()=>{
    const url=process.env.LOCAL_BACKRUN_TEST_RPC,provider=new providers.StaticJsonRpcProvider(url,1);
    const owner=Wallet.createRandom().address,triggerSigner=Wallet.createRandom();
    await provider.send("hardhat_reset",[]);
    await provider.send("hardhat_setBalance",[owner,utils.hexValue(utils.parseEther("10"))]);
    await provider.send("hardhat_setBalance",[triggerSigner.address,utils.hexValue(utils.parseEther("1"))]);
    await provider.send("hardhat_impersonateAccount",[owner]);
    await provider.send("evm_setAutomine",[true]);
    const signer=provider.getSigner(owner),artifact=name=>require(path.join("../../artifacts/contracts",
      name==="ArbitrageFlashloan"?"ArbitrageFlashloan.sol/"+name+".json":"mocks/"+name+".sol/"+name+".json"));
    async function deploy(name,args=[]){
      const a=artifact(name),contract=await new ContractFactory(a.abi,a.bytecode,signer).deploy(...args);await contract.deployed();return contract;
    }
    const a=await deploy("MockERC20",["A","A",18]),b=await deploy("MockERC20",["B","B",18]);
    const r1=await deploy("MockUniswapV2Router"),r2=await deploy("MockUniswapV2Router"),pool=await deploy("MockLendingPool",[9]);
    const ap=await deploy("MockProvider",[pool.address]),executor=await deploy("ArbitrageFlashloan",[ap.address,owner,utils.getAddress("0x"+"01".repeat(20))]);
    const amount=utils.parseEther("100");
    for(const submit of [()=>a.mint(executor.address,amount.mul(2)),()=>a.mint(pool.address,amount.mul(10)),
      ()=>a.mint(r2.address,amount.mul(10)),()=>b.mint(r1.address,amount.mul(10)),
      ()=>r1.setRate(a.address,b.address,1,1),()=>r2.setRate(b.address,a.address,1,1)])await (await submit()).wait();
    await provider.send("hardhat_stopImpersonatingAccount",[owner]);
    const parent=await latestBlock(provider);let snapshot=await provider.send("evm_snapshot",[]);
    const backend=new ForkBackend({url,provider,engine:process.env.LOCAL_BACKRUN_TEST_ENGINE||"hardhat"});
    backend.reset=async block=>{
      assert.equal(block.hash,parent.hash);assert.equal(await provider.send("evm_revert",[snapshot]),true);
      snapshot=await provider.send("evm_snapshot",[]);await provider.send("evm_setAutomine",[false]);await backend.verify();
    };
    const raw=await triggerSigner.signTransaction({to:r2.address,data:r2.interface.encodeFunctionData("setRate",[b.address,a.address,11,10]),
      nonce:0,chainId:1,type:2,gasLimit:150000,maxFeePerGas:parent.baseFeePerGas.mul(2).add(1),maxPriorityFeePerGas:1});
    const trigger={rawTx:raw,hash:utils.keccak256(raw)};
    const step={dexType:0,router:r1.address,tokenIn:a.address,tokenOut:b.address,minAmountOut:1,v3Fee:0,
      balancerPoolId:utils.hexZeroPad("0x",32),curveIndexIn:0,curveIndexOut:0,curveUnderlying:false,v2Path:[]};
    const data={borrowToken:a.address,borrowAmount:amount,steps:[step,{...step,router:r2.address,tokenIn:b.address,tokenOut:a.address}],
      minProfit:utils.parseEther("1"),route:"local controlled fixture"};
    try{
      for(const mode of ["CAPITAL","FLASH_LOAN"]){
        const applied=await backend.applyTrigger(trigger,parent);
        assert.equal(applied.triggerReceipt.status,1);
        const transaction={from:owner,to:executor.address,data:executor.interface.encodeFunctionData(mode==="CAPITAL"?"executeCapitalArbitrage":"initiateFlashLoan",[data]),
          gasLimit:1500000,maxFeePerGas:parent.baseFeePerGas.mul(2).add(1),maxPriorityFeePerGas:1};
        const result=await backend.simulateUnsignedBundle({trigger,parent,header:applied.header,transaction});
        assert.equal(result.signed,false);assert.equal(result.submitted,false);assert.equal(result.backrunReceipt.transactionIndex,1);
        assert.equal(result.targetBlock,parent.number+1);assert.equal(result.directCoinbasePayment,"0");
        assert.equal((await a.balanceOf(executor.address)).toString(),amount.mul(2).toString());
        const profit=mode==="CAPITAL"?amount.div(10):amount.div(10).sub(amount.mul(9).div(10000));
        assert.equal((await a.balanceOf(owner)).toString(),profit.toString());
        assert.equal((await a.allowance(executor.address,r1.address)).toString(),"0");
      }
    }finally{await provider.send("evm_setAutomine",[true]);}
  });
test("canonical type-3 execution retains BLOBHASH, fees and identity in an unsigned Anvil prefix",
  {skip:!process.env.LOCAL_BACKRUN_TEST_RPC||process.env.LOCAL_BACKRUN_TEST_ENGINE!=="anvil",timeout:120000},async()=>{
    const {signedBlob,versionedHash}=require("../helpers/blobTransaction");
    const url=process.env.LOCAL_BACKRUN_TEST_RPC,provider=new providers.StaticJsonRpcProvider(url,1);
    const operator=Wallet.createRandom().address,recipient=Wallet.createRandom().address,target=Wallet.createRandom().address;
    const blob=signedBlob({to:target});
    await provider.send("hardhat_reset",[]);
    for(const account of [blob.wallet.address,operator])
      await provider.send("hardhat_setBalance",[account,utils.hexValue(utils.parseEther("1"))]);
    // Store BLOBHASH(0) in slot 0, proving the type-3 execution context survives.
    await provider.send("hardhat_setCode",[target,"0x60004960005500"]);
    await provider.send("evm_setAutomine",[false]);
    const parent=await latestBlock(provider);let snapshot=await provider.send("evm_snapshot",[]);
    const backend=new ForkBackend({url,provider,engine:"anvil"});
    backend.reset=async()=>{
      assert.equal(await provider.send("evm_revert",[snapshot]),true);
      snapshot=await provider.send("evm_snapshot",[]);await provider.send("evm_setAutomine",[false]);
    };
    const header={...parent,number:parent.number+1,timestamp:parent.timestamp+12,
      baseFeePerGas:require("../../server/backrun/forkBackend").nextBaseFee(parent),
      miner:Wallet.createRandom().address,mixHash:utils.hexZeroPad("0x1234",32)};
    try{
      await assert.rejects(provider.send("eth_sendRawTransaction",[blob.raw]),/sidecar/);
      const prefix=await backend.mine([blob.raw],header,{canonicalTransactions:[blob.canonical]});
      assert.equal(prefix.receipts[0].transactionHash,blob.canonical.hash);
      assert.equal(prefix.receipts[0].type,3);assert.equal(prefix.receipts[0].status,1);
      assert.equal(await provider.getStorageAt(target,0),versionedHash);
      const receipt=await provider.send("eth_getTransactionReceipt",[blob.canonical.hash]);
      assert.equal(Number(receipt.blobGasUsed),131072);
      const burned=prefix.receipts[0].gasUsed.mul(prefix.receipts[0].effectiveGasPrice)
        .add(require("ethers").BigNumber.from(receipt.blobGasUsed).mul(receipt.blobGasPrice));
      assert.equal((await provider.getBalance(blob.wallet.address)).toString(),utils.parseEther("1").sub(burned).toString());
      assert.equal(backend.blobReplayAccounts.size,0);
      await backend.reset(parent);
      await assert.rejects(provider.send("eth_sendRawTransaction",[blob.raw]),/sidecar/);
      await backend.mine([blob.raw],header,{canonicalTransactions:[blob.canonical]});
      const result=await backend.simulateUnsignedPrefix({rawTransactions:[blob.raw],canonicalTransactions:[blob.canonical],parent,header,
        transaction:{from:operator,to:recipient,data:"0x",gasLimit:21000,
          maxFeePerGas:parent.baseFeePerGas.mul(2).add(10),maxPriorityFeePerGas:1}});
      require("../../server/backrun/historicalReplay").verifyReceipts(result.prefixReceipts,prefix.receipts);
      assert.equal(result.backrunReceipt.transactionIndex,1);
      assert.equal(await provider.getStorageAt(target,0),versionedHash);
      assert.equal(result.signed,false);assert.equal(result.submitted,false);assert.equal(result.directCoinbasePayment,"0");
    }finally{await provider.send("evm_setAutomine",[true]);}
  });
test("canonical unprotected legacy prefix is mined and revalidated before an unsigned same-block call",
  {skip:!process.env.LOCAL_BACKRUN_TEST_RPC,timeout:120000},async()=>{
    const url=process.env.LOCAL_BACKRUN_TEST_RPC,provider=new providers.StaticJsonRpcProvider(url,1);
    const triggerSigner=Wallet.createRandom(),operator=Wallet.createRandom().address,recipient=Wallet.createRandom().address;
    await provider.send("hardhat_reset",[]);
    for(const account of [triggerSigner.address,operator])
      await provider.send("hardhat_setBalance",[account,utils.hexValue(utils.parseEther("1"))]);
    await provider.send("evm_setAutomine",[false]);
    const parent=await latestBlock(provider);
    let snapshot=await provider.send("evm_snapshot",[]);
    const backend=new ForkBackend({url,provider,engine:process.env.LOCAL_BACKRUN_TEST_ENGINE||"hardhat"});
    backend.reset=async()=>{
      assert.equal(await provider.send("evm_revert",[snapshot]),true);
      snapshot=await provider.send("evm_snapshot",[]);await provider.send("evm_setAutomine",[false]);
    };
    const raw=await triggerSigner.signTransaction({to:recipient,value:1,nonce:0,chainId:0,gasLimit:21000,
      gasPrice:parent.baseFeePerGas.mul(2).add(10)});
    const canonicalTransactions=[utils.parseTransaction(raw)];
    const header={...parent,number:parent.number+1,timestamp:parent.timestamp+12,
      baseFeePerGas:require("../../server/backrun/forkBackend").nextBaseFee(parent),
      miner:Wallet.createRandom().address,mixHash:utils.hexZeroPad("0x1234",32)};
    try{
      await assert.rejects(backend.mine([raw],header),/Signed mainnet/);
      await backend.reset(parent);
      const prefix=await backend.mine([raw],header,{canonicalTransactions});
      assert.equal(prefix.receipts[0].status,1);
      const minedHeader=await provider.send("eth_getBlockByNumber",["latest",false]);
      assert.equal(minedHeader.mixHash.toLowerCase(),header.mixHash.toLowerCase());
      assert.equal(minedHeader.miner.toLowerCase(),header.miner.toLowerCase());
      assert.equal(Number(minedHeader.timestamp),header.timestamp);
      assert.equal(Number(minedHeader.baseFeePerGas),Number(header.baseFeePerGas));
      assert.equal(Number(minedHeader.gasLimit),Number(header.gasLimit));
      const result=await backend.simulateUnsignedPrefix({rawTransactions:[raw],canonicalTransactions,parent,header,
        transaction:{from:operator,to:recipient,data:"0x",gasLimit:21000,
          maxFeePerGas:parent.baseFeePerGas.mul(2).add(10),maxPriorityFeePerGas:1}});
      assert.equal(result.prefixReceipts[0].transactionHash,canonicalTransactions[0].hash);
      assert.equal(result.backrunReceipt.transactionIndex,1);
      assert.equal(result.signed,false);assert.equal(result.submitted,false);
      assert.equal(result.directCoinbasePayment,"0");
    }finally{await provider.send("evm_setAutomine",[true]);}
  });

test("local executor diagnostic preserves historical prefix and settles both funding modes after gas",
  {skip:!process.env.LOCAL_BACKRUN_TEST_RPC||process.env.LOCAL_BACKRUN_TEST_ENGINE!=="anvil",timeout:180000},async()=>{
    const {prepareLocalExecutor,executeLocalMode}=require("../../server/backrun/localExecutorDiagnostic");
    const url=process.env.LOCAL_BACKRUN_TEST_RPC,provider=new providers.StaticJsonRpcProvider(url,1);
    const creator=Wallet.createRandom().address,triggerSigner=Wallet.createRandom();
    await provider.send("hardhat_reset",[]);await provider.send("evm_setAutomine",[false]);
    await provider.send("hardhat_setBalance",[creator,utils.hexValue(utils.parseEther("5000"))]);
    await provider.send("hardhat_setBalance",[triggerSigner.address,utils.hexValue(utils.parseEther("1"))]);
    await provider.send("hardhat_impersonateAccount",[creator]);
    const artifact=name=>require(path.join("../../artifacts/contracts",
      name==="ArbitrageFlashloan"?"ArbitrageFlashloan.sol/"+name+".json":"mocks/"+name+".sol/"+name+".json"));
    async function send(data,to,value=0){
      const request={from:creator,data,gas:utils.hexValue(6000000),value:utils.hexValue(value)};if(to)request.to=to;
      const hash=await provider.send("eth_sendTransaction",[request]);await provider.send("evm_mine",[]);
      const receipt=provider.formatter.receipt(await provider.send("eth_getTransactionReceipt",[hash]));assert.equal(receipt.status,1);return receipt;
    }
    async function deploy(name,args=[]){const a=artifact(name),tx=new ContractFactory(a.abi,a.bytecode).getDeployTransaction(...args);
      const receipt=await send(tx.data);return new(require("ethers").Contract)(receipt.contractAddress,a.abi,provider);}
    async function call(c,name,args=[],value=0){return send(c.interface.encodeFunctionData(name,args),c.address,value);}
    const weth=await deploy("MockWrappedNative"),other=await deploy("MockERC20",["B","B",18]);
    const r1=await deploy("MockUniswapV2Router"),r2=await deploy("MockUniswapV2Router");
    const pool=await deploy("MockLendingPool",[9]),ap=await deploy("MockProvider",[pool.address]);
    const amount=utils.parseEther("100");
    await call(weth,"deposit",[],amount.mul(20));
    await call(weth,"transfer",[pool.address,amount.mul(10)]);await call(weth,"transfer",[r2.address,amount.mul(10)]);
    await call(other,"mint",[r1.address,amount.mul(10)]);
    await call(r1,"setRate",[weth.address,other.address,1,1]);await call(r2,"setRate",[other.address,weth.address,1,1]);
    await provider.send("hardhat_stopImpersonatingAccount",[creator]);
    const parent=await latestBlock(provider);let snapshot=await provider.send("evm_snapshot",[]);
    const backend=new ForkBackend({url,provider,engine:"anvil"});
    backend.reset=async block=>{backend.assertMiningSettled();assert.equal(block.hash,parent.hash);
      assert.equal(await provider.send("evm_revert",[snapshot]),true);snapshot=await provider.send("evm_snapshot",[]);
      await provider.send("evm_setAutomine",[false]);};
    const raw=await triggerSigner.signTransaction({to:r2.address,data:r2.interface.encodeFunctionData("setRate",[other.address,weth.address,11,10]),
      chainId:1,nonce:0,type:2,gasLimit:150000,maxFeePerGas:parent.baseFeePerGas.mul(2).add(1),maxPriorityFeePerGas:1});
    const canonical=utils.parseTransaction(raw),header={...parent,number:parent.number+1,timestamp:parent.timestamp+12,
      baseFeePerGas:require("../../server/backrun/forkBackend").nextBaseFee(parent)};
    await backend.reset(parent);const prefix=await backend.mine([raw],header,{canonicalTransactions:[canonical]});
    const data={parent,block:{...header,transactions:[canonical]},raw:[raw],receipts:[prefix.receipts[0],{effectiveGasPrice:header.baseFeePerGas.add(1)}]};
    const local=await prepareLocalExecutor({backend,parent,artifact:artifact("ArbitrageFlashloan"),addressesProvider:ap.address,
      lendingPool:pool.address,wrappedNative:weth.address,amount});
    const step={dexType:0,router:r1.address,tokenIn:weth.address,tokenOut:other.address,minAmountOut:1,v3Fee:0,
      balancerPoolId:utils.hexZeroPad("0x",32),curveIndexIn:0,curveIndexOut:0,curveUnderlying:false,v2Path:[]};
    const quoteData={borrowToken:weth.address,borrowAmount:amount,steps:[step,{...step,router:r2.address,tokenIn:other.address,tokenOut:weth.address}],
      minProfit:1,route:"controlled diagnostic integration"};
    try{
      const results=[];
      for(const fundingMode of ["CAPITAL","FLASH_LOAN"]){
        const result=await executeLocalMode({backend,data,endIndex:0,local,quoteData,fundingMode,minimumProfit:utils.parseEther("1")});
        assert.equal(result.executionSucceeded,true);assert.equal(result.canonicalReceiptsVerified,true);
        assert.equal(result.sameBlock,true);assert.equal(result.transactionIndex,1);assert.equal(result.unsigned,true);
        assert.equal(result.principalPreserved,true);assert.equal(result.routerAllowancesCleared,true);
        assert.equal(result.startingExecutorWeth,fundingMode==="CAPITAL"?amount.toString():"0");
        assert.equal(result.syntheticCapital,fundingMode==="CAPITAL");
        assert.equal(result.aaveAllowanceCleared,true);assert.equal(result.netPositive,true);
        assert.equal(result.grossBeforeFundingFee,amount.div(10).toString());
        assert.equal(result.flashloanFee,fundingMode==="CAPITAL"?"0":amount.mul(9).div(10000).toString());
        assert.equal(require("ethers").BigNumber.from(result.profitWithdrawn).sub(result.gasCostNative).toString(),result.netAfterGasNative);
        results.push(result);
      }
      assert.equal(await local.executor.owner(),local.owner);
      assert.equal((await weth.balanceOf(local.executor.address)).toString(),"0");
      assert.equal((await weth.balanceOf(pool.address)).toString(),amount.mul(10).add(amount.mul(9).div(10000)).toString());
      await assert.rejects(backend.reset({...parent,hash:utils.hexZeroPad("0x1234",32)}),/pinned/);
    }finally{local.restoreReset();await provider.send("evm_setAutomine",[true]);}
  });
