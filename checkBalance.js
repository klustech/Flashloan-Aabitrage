// checkBalance.js
const { ethers } = require("ethers");
require('dotenv').config();

async function main() {
    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const balance = await wallet.getBalance();
    console.log(`Wallet Balance: ${ethers.utils.formatEther(balance)} ETH`);
}

main().catch(error => {
    console.error("Error fetching balance:", error);
});
