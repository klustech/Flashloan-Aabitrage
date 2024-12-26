// scripts/testTransaction.js

const { logMessage } = require('./logging');
const { ethers } = require('ethers');
const { provider, wallet } = require('./provider');

/**
 * Simple script to test a transaction by sending 0.01 ETH to your own address.
 * Use this to confirm that your wallet and provider are configured correctly.
 */
async function testTransaction() {
    try {
        if (!wallet) {
            throw new Error('Wallet instance is undefined. Ensure provider.js initializes the wallet correctly.');
        }

        const balance = await wallet.getBalance();
        logMessage(`Initial Wallet Balance: ${ethers.utils.formatEther(balance)} ETH`, {}, 'info');

        // Send a small transaction to self
        const tx = await wallet.sendTransaction({
            to: wallet.address,
            value: ethers.utils.parseEther('0.01'), // 0.01 ETH
            gasLimit: ethers.utils.hexlify(21000), // Standard gas limit for ETH transfer
        });

        logMessage(`Test Transaction Sent: ${tx.hash}`, {}, 'info');

        // Wait for transaction confirmation
        const receipt = await tx.wait();
        logMessage(`Test Transaction Confirmed in Block ${receipt.blockNumber}`, {}, 'info');

        const finalBalance = await wallet.getBalance();
        logMessage(`Final Wallet Balance: ${ethers.utils.formatEther(finalBalance)} ETH`, {}, 'info');
    } catch (error) {
        logMessage(`Error in testTransaction: ${error.message}`, {}, 'error');
        console.error(error);
    }
}

testTransaction();
