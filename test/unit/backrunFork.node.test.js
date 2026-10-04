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
    for(const tx of [a.mint(executor.address,amount.mul(2)),a.mint(pool.address,amount.mul(10)),
      a.mint(r2.address,amount.mul(10)),b.mint(r1.address,amount.mul(10)),
      r1.setRate(a.address,b.address,1,1),r2.setRate(b.address,a.address,1,1)])await (await tx).wait();
    await provider.send("hardhat_stopImpersonatingAccount",[owner]);
    const parent=await latestBlock(provider);let snapshot=await provider.send("evm_snapshot",[]);
    const backend=new ForkBackend({url,provider});
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
    const backend=new ForkBackend({url,provider});
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
