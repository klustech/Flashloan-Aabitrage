const {expect}=require('chai');
const {ethers}=require('hardhat');
describe('Production executor invariants',function(){
  let a,b,r1,r2,pool,arb,owner,governance;
  const amount=ethers.utils.parseEther('100');
  beforeEach(async()=>{
    const signers=await ethers.getSigners();owner=signers[0];governance=signers[signers.length-1];const Token=await ethers.getContractFactory('MockERC20');a=await Token.deploy('A','A',18);b=await Token.deploy('B','B',18);
    const Router=await ethers.getContractFactory('MockUniswapV2Router');r1=await Router.deploy();r2=await Router.deploy();pool=await(await ethers.getContractFactory('MockLendingPool')).deploy(9);
    const provider=await(await ethers.getContractFactory('MockProvider')).deploy(pool.address);arb=await(await ethers.getContractFactory('ArbitrageFlashloan')).deploy(provider.address,owner.address,governance.address,owner.address,[r1.address,r2.address]);
    await a.mint(pool.address,amount.mul(10));await b.mint(r1.address,amount.mul(10));await a.mint(r2.address,amount.mul(10));await r1.setRate(a.address,b.address,1,1);await r2.setRate(b.address,a.address,11,10);
  });
  function data(){const step={dexType:0,router:r1.address,tokenIn:a.address,tokenOut:b.address,minAmountOut:1,v3Fee:0,balancerPoolId:ethers.constants.HashZero,curveIndexIn:0,curveIndexOut:0,curveUnderlying:false,v2Path:[]};return {borrowToken:a.address,borrowAmount:amount,minProfit:ethers.utils.parseEther('1'),steps:[step,{...step,router:r2.address,tokenIn:b.address,tokenOut:a.address}],route:'A-B-A'};}
  it('prefunded tokens cannot subsidize an unprofitable route',async()=>{await a.mint(arb.address,amount);await r2.setRate(b.address,a.address,1,1);await expect(arb.initiateFlashLoan(data())).to.be.revertedWith('profit<minProfit');expect(await a.balanceOf(arb.address)).to.equal(amount);});
  it('pays only trade profit and retains prefunded balances',async()=>{await a.mint(arb.address,amount);const before=await a.balanceOf(owner.address);await arb.initiateFlashLoan(data());const profit=amount.div(10).sub(amount.mul(9).div(10000));expect((await a.balanceOf(owner.address)).sub(before)).to.equal(profit);expect(await a.balanceOf(arb.address)).to.equal(amount);expect(await a.allowance(arb.address,r1.address)).to.equal(0);});
  it('refuses zero output limits, invalid path endpoints and missing pool IDs',async()=>{let d=data();d.steps[0].minAmountOut=0;await expect(arb.initiateFlashLoan(d)).to.be.revertedWith('zero minimum output');d=data();d.steps[0].v2Path=[b.address,a.address];await expect(arb.initiateFlashLoan(d)).to.be.revertedWith('v2 path mismatch');d=data();d.steps[0].dexType=3;await expect(arb.initiateFlashLoan(d)).to.be.revertedWith('missing pool id');});
  it('rejects unsolicited callbacks even from the configured pool',async()=>{await ethers.provider.send('hardhat_impersonateAccount',[pool.address]);await ethers.provider.send('hardhat_setBalance',[pool.address,'0x10000000000000000']);const signer=await ethers.getSigner(pool.address);await expect(arb.connect(signer).executeOperation([a.address],[amount],[0],arb.address,'0x')).to.be.revertedWith('unexpected callback');await ethers.provider.send('hardhat_stopImpersonatingAccount',[pool.address]);});
  it('rejects routers governance has not approved, even for the executor',async()=>{const d=data();await arb.connect(governance).setRouter(r2.address,false);await expect(arb.initiateFlashLoan(d)).to.be.revertedWith('router not approved');await a.mint(arb.address,amount);await expect(arb.executeCapitalArbitrage(d)).to.be.revertedWith('router not approved');});
  it('pause prevents flashloan initiation and executor version is explicit',async()=>{expect(await arb.executorVersion()).to.equal(4);await arb.pause();await expect(arb.initiateFlashLoan(data())).to.be.revertedWith('Pausable: paused');});
  it('capital execution retains all principal, pays only profit and cleans both allowances',async()=>{
    await a.mint(arb.address,amount.mul(3));const before=await a.balanceOf(owner.address);
    await arb.executeCapitalArbitrage(data());
    expect(await a.balanceOf(arb.address)).to.equal(amount.mul(3));
    expect((await a.balanceOf(owner.address)).sub(before)).to.equal(amount.div(10));
    expect(await a.allowance(arb.address,r1.address)).to.equal(0);expect(await b.allowance(arb.address,r2.address)).to.equal(0);
    expect(await a.balanceOf(pool.address)).to.equal(amount.mul(10));
  });
  it('capital execution rejects insufficient funds, zero output, broken continuity and pause',async()=>{
    await expect(arb.executeCapitalArbitrage(data())).to.be.revertedWith('insufficient capital');
    await a.mint(arb.address,amount);
    let d=data();d.steps[0].minAmountOut=0;await expect(arb.executeCapitalArbitrage(d)).to.be.revertedWith('zero minimum output');
    d=data();d.steps[1].tokenIn=a.address;await expect(arb.executeCapitalArbitrage(d)).to.be.reverted;
    await arb.pause();await expect(arb.executeCapitalArbitrage(data())).to.be.revertedWith('Pausable: paused');
  });
});
