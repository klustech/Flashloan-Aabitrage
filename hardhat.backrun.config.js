// Dedicated, disposable simulation node. Never use the application's signer.
const config = require("./hardhat.config");
if(process.env.PRIVATE_KEY)throw new Error("Disposable backrun node refuses PRIVATE_KEY");
module.exports = { ...config, networks: { hardhat: {
  chainId: 1, accounts: [], loggingEnabled: false, allowUnlimitedContractSize: false,
  throwOnTransactionFailures: false, throwOnCallFailures: true,
  mining: { auto: false, interval: 0, mempool: { order: "fifo" } },
} } };
