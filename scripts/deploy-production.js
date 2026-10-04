require('dotenv').config();
const {ethers}=require('hardhat');
const fs=require('fs');
const {productionProfile}=require('../server/config/productionProfile');
async function main(){
  const profile=productionProfile();if((await ethers.provider.getNetwork()).chainId!==1)throw new Error('Production deployment requires Ethereum mainnet');
  const [operator]=await ethers.getSigners();if(!operator)throw new Error('Deployment signer unavailable');
  if(await ethers.provider.getCode(profile.flashloanProvider.addressesProvider)==='0x')throw new Error('Aave V2 provider not deployed');
  const Timelock=await ethers.getContractFactory('ArbitrageTimelock',operator);
  const timelock=await Timelock.deploy(Number(process.env.TIMELOCK_MIN_DELAY_SEC||86400),[operator.address],[operator.address],operator.address);await timelock.deployed();
  const recipient=process.env.PROFIT_RECIPIENT||operator.address;
  const Executor=await ethers.getContractFactory('ArbitrageFlashloan',operator);
  const contract=await Executor.deploy(profile.flashloanProvider.addressesProvider,recipient,timelock.address);await contract.deployed();
  const code=await ethers.provider.getCode(contract.address);
  const manifest={CONTRACT_ADDRESS:contract.address,OPERATOR_ADDRESS:operator.address,EXPECTED_CONTRACT_OWNER:operator.address,EXPECTED_PROFIT_RECIPIENT:recipient,EXPECTED_TIMELOCK:timelock.address,EXPECTED_CONTRACT_CODE_HASH:ethers.utils.keccak256(code),AAVE_LENDING_POOL_ADDRESS_PROVIDER:profile.flashloanProvider.addressesProvider,AAVE_V2_LENDING_POOL:profile.flashloanProvider.lendingPool,executorVersion:3};
  fs.mkdirSync('runtime',{recursive:true,mode:0o700});fs.writeFileSync('runtime/deployment.json',JSON.stringify(manifest,null,2),{mode:0o600});console.log(JSON.stringify(manifest,null,2));
}
if(require.main===module)main().catch(err=>{console.error(err.message);process.exitCode=1;});
module.exports={main};
