require('dotenv').config();
const {ethers}=require('hardhat');
const fs=require('fs');
const {productionProfile}=require('../server/config/productionProfile');
const {EXECUTOR_VERSION}=require('../server/config/executorVersion');

// Authority layout:
//   GOVERNANCE_ADDRESS (multisig) -> sole proposer/executor of ArbitrageTimelock
//   ArbitrageTimelock             -> executor admin (routers, executors, rescue, unpause, recipient)
//   OPERATOR_ADDRESS (hot bot)    -> executor role only
//   PROFIT_RECIPIENT (cold)       -> receives realized profit
// The deployment key gets no role at all.
function requiredAddress(name){
  const value=process.env[name];
  if(!value||!ethers.utils.isAddress(value))throw new Error(`${name} must be set to a valid address`);
  return ethers.utils.getAddress(value);
}

async function main(){
  const profile=productionProfile();if((await ethers.provider.getNetwork()).chainId!==1)throw new Error('Production deployment requires Ethereum mainnet');
  const [deployer]=await ethers.getSigners();if(!deployer)throw new Error('Deployment signer unavailable');
  const governance=requiredAddress('GOVERNANCE_ADDRESS'),operator=requiredAddress('OPERATOR_ADDRESS'),recipient=requiredAddress('PROFIT_RECIPIENT');
  if(new Set([governance,operator,recipient]).size!==3)throw new Error('GOVERNANCE_ADDRESS, OPERATOR_ADDRESS and PROFIT_RECIPIENT must all differ');
  if(deployer.address===operator||deployer.address===governance)throw new Error('Deploy with a key that holds neither the operator nor the governance role');
  if(await ethers.provider.getCode(governance)==='0x')throw new Error('GOVERNANCE_ADDRESS must be a multisig contract');
  if(await ethers.provider.getCode(profile.flashloanProvider.addressesProvider)==='0x')throw new Error('Aave V2 provider not deployed');
  const routers=[...new Set(Object.values(profile.routers).map(r=>ethers.utils.getAddress(r.router)))];
  for(const router of routers)if(await ethers.provider.getCode(router)==='0x')throw new Error(`Router ${router} has no code`);

  // admin = AddressZero makes the timelock self-administered: only a delayed,
  // multisig-proposed operation can change its own roles.
  const Timelock=await ethers.getContractFactory('ArbitrageTimelock',deployer);
  const timelock=await Timelock.deploy(Number(process.env.TIMELOCK_MIN_DELAY_SEC||86400),[governance],[governance],ethers.constants.AddressZero);await timelock.deployed();
  const Executor=await ethers.getContractFactory('ArbitrageFlashloan',deployer);
  const contract=await Executor.deploy(profile.flashloanProvider.addressesProvider,recipient,timelock.address,operator,routers);await contract.deployed();
  const code=await ethers.provider.getCode(contract.address);
  const manifest={CONTRACT_ADDRESS:contract.address,OPERATOR_ADDRESS:operator,EXPECTED_ADMIN:timelock.address,GOVERNANCE_ADDRESS:governance,EXPECTED_PROFIT_RECIPIENT:recipient,EXPECTED_CONTRACT_CODE_HASH:ethers.utils.keccak256(code),AAVE_LENDING_POOL_ADDRESS_PROVIDER:profile.flashloanProvider.addressesProvider,AAVE_V2_LENDING_POOL:profile.flashloanProvider.lendingPool,approvedRouters:routers,executorVersion:EXECUTOR_VERSION};
  fs.mkdirSync('runtime',{recursive:true,mode:0o700});fs.writeFileSync('runtime/deployment.json',JSON.stringify(manifest,null,2),{mode:0o600});console.log(JSON.stringify(manifest,null,2));
}
if(require.main===module)main().catch(err=>{console.error(err.message);process.exitCode=1;});
module.exports={main};
