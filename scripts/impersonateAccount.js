const { ethers } = require("hardhat");

async function main() {
  const impersonatedAddress = "0xF977814e90dA44bFA03b6295A0616a897441aceC"; // Binance Hot Wallet
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [impersonatedAddress],
  });

  const signer = await ethers.getSigner(impersonatedAddress);

  // Ensure the test wallet address is checksummed
  const testWallet = ethers.utils.getAddress("0x8626f6940E2eb28930efb4cef49b2d1f2c9c1199");
  console.log(`Funding test wallet (${testWallet})...`);

  const latestBlock = await ethers.provider.getBlock("latest");
  const baseFeePerGas = latestBlock.baseFeePerGas;
  const maxPriorityFeePerGas = ethers.utils.parseUnits("2", "gwei");

  const tx = await signer.sendTransaction({
    to: testWallet,
    value: ethers.utils.parseEther("50"),
    maxFeePerGas: baseFeePerGas.add(maxPriorityFeePerGas),
    maxPriorityFeePerGas: maxPriorityFeePerGas,
  });

  await tx.wait();
  console.log("Funds transferred!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
