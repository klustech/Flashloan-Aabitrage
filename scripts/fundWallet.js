// scripts/fundWallet.js
async function main() {
    const [deployer] = await ethers.getSigners();

    const receiverAddress = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";
    const amount = ethers.utils.parseEther("10"); // Amount of ETH to send

    console.log(`Funding ${receiverAddress} with ${ethers.utils.formatEther(amount)} ETH...`);
    const tx = await deployer.sendTransaction({
        to: receiverAddress,
        value: amount
    });

    await tx.wait();
    console.log(`Funded ${receiverAddress}. Transaction Hash: ${tx.hash}`);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
