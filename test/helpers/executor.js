// Deploys ArbitrageFlashloan with the hot signer (signers[0]) as executor, a
// separate governance signer (the last one) as admin, and the given routers.
async function deployExecutor(ethers, providerAddress, recipient, routers = []) {
  const signers = await ethers.getSigners();
  const executor = signers[0], governance = signers[signers.length - 1];
  const Arb = await ethers.getContractFactory("ArbitrageFlashloan");
  const arb = await Arb.deploy(providerAddress, recipient, governance.address, executor.address, routers);
  await arb.deployed();
  return { arb, governance, executor };
}
module.exports = { deployExecutor };
