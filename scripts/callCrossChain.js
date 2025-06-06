// scripts/callCrossChain.js
const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const [signer] = await ethers.getSigners();
  const connextAddress = process.env.CONNEXT_CONTRACT_ADDRESS;
  const connext = await ethers.getContractAt(
    "IConnext",
    connextAddress,
    signer
  );

  const destinationDomain = parseInt(process.env.TO_DOMAIN_ID, 10);
  const to = process.env.TO_CONTRACT_ADDRESS;
  const asset = ethers.constants.AddressZero;
  const amount = 0;
  const slippage = 0;
  const ids = [1, 2, 3];
  const hashes = [
    ethers.constants.HashZero,
    ethers.constants.HashZero,
    ethers.constants.HashZero,
  ];
  const callData = ethers.utils.defaultAbiCoder.encode(
    ["address", "uint256", "uint256[]", "bytes32[]"],
    [signer.address, amount, ids, hashes]
  );

  const relayerFee = await connext.estimateFee(
    destinationDomain,
    to,
    callData,
    slippage
  );

  const tx = await connext.xcall(
    destinationDomain,
    to,
    asset,
    signer.address,
    amount,
    slippage,
    callData,
    { value: relayerFee }
  );

  console.log("Transaction hash:", tx.hash);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
