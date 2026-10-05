// Exercises MEV-Share log-derived state writes on a real local EVM (Hardhat or
// Anvil). Gated like the other dedicated local-fork tests.
const test=require("node:test"),assert=require("node:assert/strict"),path=require("path");
const {providers,ContractFactory,Wallet,utils,BigNumber}=require("ethers");
const {ForkStateWriter,parsePoolEffects}=require("../../server/backrun/mevShareHints");
const {TokenRegistry}=require("../../server/market/tokenRegistry");
const {PoolRegistry}=require("../../server/market/poolRegistry");

const url=process.env.LOCAL_BACKRUN_TEST_RPC;
const artifact=name=>require(path.join("../../artifacts/contracts/mocks",name+".sol",name+".json"));
const enc=(types,values)=>utils.defaultAbiCoder.encode(types,values);
const TOPIC={v2swap:utils.id("Swap(address,uint256,uint256,uint256,uint256,address)"),sync:utils.id("Sync(uint112,uint112)"),
  v3swap:utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)")};

async function setup(){
  const provider=new providers.StaticJsonRpcProvider(url,1),owner=Wallet.createRandom().address;
  await provider.send("hardhat_setBalance",[owner,utils.hexValue(utils.parseEther("10"))]);
  await provider.send("hardhat_impersonateAccount",[owner]);
  await provider.send("evm_setAutomine",[true]);
  const signer=provider.getSigner(owner);
  const deploy=async(name,args)=>{const a=artifact(name),c=await new ContractFactory(a.abi,a.bytecode,signer).deploy(...args);await c.deployed();return c;};
  const t0=await deploy("MockERC20",["A","A",18]),t1=await deploy("MockERC20",["B","B",18]);
  const [token0,token1]=[t0,t1].sort((x,y)=>x.address.toLowerCase()<y.address.toLowerCase()?-1:1);
  const pair=await deploy("MockV2PairLayout",[token0.address,token1.address,1000000,2000000]);
  const v3=await deploy("MockV3PoolLayout",[BigNumber.from(2).pow(96),-120,5000000]);
  for(const [t,to,amt] of [[token0,pair,1000000],[token1,pair,2000000],[token0,v3,700],[token1,v3,900]])await (await t.mint(to.address,amt)).wait();
  await provider.send("hardhat_stopImpersonatingAccount",[owner]);
  const tokens=new TokenRegistry(null,1);
  tokens.register({address:token0.address,symbol:"A",decimals:18});tokens.register({address:token1.address,symbol:"B",decimals:18});
  const registry=new PoolRegistry(tokens);
  registry.add({dex:"uniswap_v2",poolAddress:pair.address,router:owner,factory:owner,token0:token0.address,token1:token1.address,reserve0:BigNumber.from(1),reserve1:BigNumber.from(1),feeBps:30});
  registry.add({dex:"uniswap_v3",poolAddress:v3.address,router:owner,factory:owner,quoter:owner,token0:token0.address,token1:token1.address,feeTier:500,sqrtPriceX96:BigNumber.from(2).pow(96),liquidity:BigNumber.from(1)});
  const snapshot=await provider.send("evm_snapshot",[]);
  return {provider,token0,token1,pair,v3,registry,snapshot};
}

test("MEV-Share log-derived state is written exactly and verified on a local EVM",{skip:!url,timeout:120000},async()=>{
  const {provider,token0,token1,pair,v3,registry,snapshot}=await setup();
  try{
    const effects=parsePoolEffects([
      {address:pair.address,topics:[TOPIC.v2swap],data:enc(["uint256","uint256","uint256","uint256"],[1000,0,0,1990])},
      {address:v3.address,topics:[TOPIC.v3swap],data:enc(["int256","int256","uint160","uint128","int24"],[-300,450,BigNumber.from(2).pow(96).mul(101).div(100),4800000,80])},
    ],registry);
    const writer=new ForkStateWriter(provider),applied=await writer.apply(effects);
    assert.equal(applied.length,2);
    const [r0,r1]=await pair.getReserves();
    assert.equal(r0.toString(),"1001000");assert.equal(r1.toString(),"1998010");
    assert.equal((await token0.balanceOf(pair.address)).toString(),"1001000");
    assert.equal((await token1.balanceOf(pair.address)).toString(),"1998010");
    const slot0=await v3.slot0();
    assert.equal(slot0.sqrtPriceX96.toString(),BigNumber.from(2).pow(96).mul(101).div(100).toString());
    assert.equal(slot0.tick,80);
    // Packed fields above the tick are preserved.
    assert.equal(slot0.observationIndex,7);assert.equal(slot0.observationCardinality,9);assert.equal(slot0.unlocked,true);
    assert.equal((await v3.liquidity()).toString(),"4800000");
    assert.equal((await v3.feeGrowthGlobal0X128()).toString(),"123");
    assert.equal((await token0.balanceOf(v3.address)).toString(),"400");
    assert.equal((await token1.balanceOf(v3.address)).toString(),"1350");
    // Sync gives absolute reserves.
    await writer.apply(parsePoolEffects([{address:pair.address,topics:[TOPIC.sync],data:enc(["uint112","uint112"],[1200000,1700000])}],registry));
    const [s0,s1]=await pair.getReserves();
    assert.equal(s0.toString(),"1200000");assert.equal(s1.toString(),"1700000");
    assert.equal((await token0.balanceOf(pair.address)).toString(),"1200000");
  }finally{await provider.send("evm_revert",[snapshot]);}
});

test("MEV-Share state writer fails closed on inconsistent hints and unknown layouts",{skip:!url,timeout:120000},async()=>{
  const {provider,pair,v3,registry,snapshot}=await setup();
  try{
    const writer=new ForkStateWriter(provider);
    // A swap paying out more than the parent reserve cannot apply to this state.
    await assert.rejects(writer.apply(parsePoolEffects([{address:pair.address,topics:[TOPIC.v2swap],
      data:enc(["uint256","uint256","uint256","uint256"],[0,1,1000001,0])}],registry)),/inconsistent_with_parent_state/);
    // A V3-looking pool whose slot0 is not at slot 0 is refused, never guessed.
    const misregistered=new PoolRegistry(registry.tokens);
    misregistered.add({...registry.values().find(p=>p.protocolVersion===3),poolAddress:pair.address});
    await assert.rejects(writer.apply(parsePoolEffects([{address:pair.address,topics:[TOPIC.v3swap],
      data:enc(["int256","int256","uint160","uint128","int24"],[1,1,BigNumber.from(2).pow(96),1,0])}],misregistered)));
    const [r0]=await pair.getReserves();assert.equal(r0.toString(),"1000000");
    assert.equal((await v3.liquidity()).toString(),"5000000");
  }finally{await provider.send("evm_revert",[snapshot]);}
});

test("ForkBackend mines log-derived state and simulates the backrun alone in block N+1",{skip:!url,timeout:120000},async()=>{
  const {ForkBackend,latestBlock}=require("../../server/backrun/forkBackend");
  const {provider,pair,registry}=await setup();
  const from=Wallet.createRandom().address;
  await provider.send("hardhat_setBalance",[from,utils.hexValue(utils.parseEther("1"))]);
  const parent=await latestBlock(provider);let snapshot=await provider.send("evm_snapshot",[]);
  const backend=new ForkBackend({url,provider,engine:process.env.LOCAL_BACKRUN_TEST_ENGINE||"hardhat"});
  backend.reset=async block=>{
    assert.equal(block.hash,parent.hash);assert.equal(await provider.send("evm_revert",[snapshot]),true);
    snapshot=await provider.send("evm_snapshot",[]);await provider.send("evm_setAutomine",[false]);await backend.verify();
  };
  try{
    const trigger={hash:"0x"+"cd".repeat(32),rawTx:null,source:"mev_share",poolEffects:parsePoolEffects([
      {address:pair.address,topics:[TOPIC.sync],data:enc(["uint112","uint112"],[1500000,1400000])}],registry)};
    const applied=await backend.applyHint(trigger,parent);
    assert.equal(applied.block.number,parent.number+1);assert.equal(applied.block.transactions.length,0);
    const [r0]=await pair.getReserves({blockTag:applied.block.number});assert.equal(r0.toString(),"1500000");
    const fee=applied.header.baseFeePerGas.mul(2);
    const sim=await backend.simulateUnsignedBundle({trigger,parent,header:applied.header,transaction:{from,to:pair.address,
      data:pair.interface.encodeFunctionData("getReserves"),gasLimit:100000,maxFeePerGas:fee,maxPriorityFeePerGas:1}});
    assert.equal(sim.kind,"UNSIGNED_FORK_LOG_DERIVED_STATE");assert.equal(sim.triggerHash,null);assert.equal(sim.triggerGasUsed,null);
    assert.equal(sim.targetBlock,parent.number+1);assert.equal(sim.directCoinbasePayment,"0");
    const [s0]=await pair.getReserves({blockTag:sim.targetBlock});assert.equal(s0.toString(),"1500000");
  }finally{await provider.send("evm_setAutomine",[true]);await provider.send("evm_revert",[snapshot]);}
});
