const { ethers } = require("hardhat");

async function main() {
  // Impersonate a mainnet account with sufficient balance
  const impersonatedAddress = "0xF977814e90dA44bFA03b6295A0616a897441aceC"; // Binance Hot Wallet
  
  console.log(`Impersonating account: ${impersonatedAddress}`);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [impersonatedAddress],
  });

  const signer = await ethers.getSigner(impersonatedAddress);
  
  // Check and display the balance of the impersonated account
  const balance = await signer.getBalance();
  console.log(`Impersonated account balance: ${ethers.utils.formatEther(balance)} ETH`);

  // Transfer ETH to a Hardhat test wallet for testing purchases
  const testWallet = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // Hardhat default test wallet
  const tx = await signer.sendTransaction({
    to: testWallet,
    value: ethers.utils.parseEther("10"), // Send 10 ETH
  });

  await tx.wait();
  console.log(`10 ETH transferred to test wallet: ${testWallet}`);

  // Simulate a PairCreated event by interacting with the Uniswap factory
  const factoryAddress = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"; // Uniswap V2 Factory
  const factory = await ethers.getContractAt("IUniswapV2Factory", factoryAddress);

  const tokenA = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // WETH
  const tokenB = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // DAI

  console.log(`Creating pair for ${tokenA} and ${tokenB}...`);

  const createPairTx = await factory.createPair(tokenA, tokenB);
  await createPairTx.wait();

  console.log("PairCreated event simulated successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
