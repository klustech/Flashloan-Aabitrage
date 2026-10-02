// Real fork proof: no mocked pools, reserves, flashloan, or token balances.
const {expect}=require('chai');
const {ethers}=require('hardhat');
const fs=require('fs');
const path=require('path');
const {productionProfile}=require('../../server/config/productionProfile');
const {Coordinator}=require('../../server/bot/coordinator');
const {TradingStateMachine}=require('../../server/bot/stateMachine');
const {TradeLedger}=require('../../server/bot/tradeLedger');
const {serialize}=require('../../server/bot/units');
const enabled=process.env.ENABLE_MAINNET_FORK==='true'&&Boolean(process.env.MAINNET_RPC_URL)&&Boolean(process.env.FORK_BLOCK_NUMBER);
(enabled?describe:describe.skip)('Production mainnet-fork proof',function(){
  this.timeout(600000);
  it('discovers real exact pools, repays real Aave V2 and increases recipient balance',async()=>{
    const original=productionProfile();const [operator]=await ethers.getSigners();
    const contract=await(await ethers.getContractFactory('ArbitrageFlashloan')).deploy(original.flashloanProvider.addressesProvider,operator.address,ethers.constants.AddressZero);await contract.deployed();
    const profile={...original,chainId:(await ethers.provider.getNetwork()).chainId,contractAddress:contract.address,operatorAddress:operator.address,maxQuoteAgeMs:60000,maxPoolStateAgeMs:60000};
    const state=new TradingStateMachine();state.paper();
    const coordinator=new Coordinator({provider:ethers.provider,profile,state,ledger:new TradeLedger({file:null})});
    const result=await coordinator.cycle();
    expect(result.simulated,`Fork proof failed: ${result.reason||'no exactly profitable route at the selected historical block'}`).to.equal(true);
    const trade=result.trade,data=trade.swapData;
    const token=new ethers.Contract(trade.borrowToken,['function balanceOf(address) view returns(uint256)'],operator);
    const before=await token.balanceOf(operator.address);
    const tx=await contract.connect(operator).initiateFlashLoan(data);
    const receipt=await tx.wait();expect(receipt.status).to.equal(1);
    const after=await token.balanceOf(operator.address);expect(after.gt(before)).to.equal(true);
    const report=serialize({passed:true,profileFingerprint:original.fingerprint,blockNumber:Number(process.env.FORK_BLOCK_NUMBER),txHash:receipt.transactionHash,route:trade.route,borrowAmount:trade.borrowAmount,flashloanPremium:trade.flashloanPremium,profitRecipientIncrease:after.sub(before),executorAddress:contract.address,generatedAt:Date.now()});
    const output=process.env.FORK_PROOF_PATH||'runtime/fork-proof.json';fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
  });
});
