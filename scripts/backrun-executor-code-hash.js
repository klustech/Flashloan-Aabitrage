// Read-only: derives EXPECTED_CONTRACT_CODE_HASH from the deployed executor
// (keccak256 of its runtime code at CONTRACT_ADDRESS) after checking it is
// executor v4 on Ethereum mainnet. Prints the line to put in the env file and
// whether the configured value already matches. Signs and changes nothing.
// Setting the value changes the profile fingerprint: re-run local
// validation afterwards (npm run backrun:validate-local).
const { providers, Contract, utils } = require("ethers");
const { loadEnvironment } = require("./paper-preflight");
const { EXECUTOR_VERSION } = require("../server/config/executorVersion");

async function codeHash(env = process.env, provider) {
  if (env.PRIVATE_KEY) throw new Error("Refusing to run with PRIVATE_KEY present");
  if (!env.CONTRACT_ADDRESS || !utils.isAddress(env.CONTRACT_ADDRESS)) throw new Error("CONTRACT_ADDRESS must be the deployed executor address");
  if (!provider && !env.MAINNET_RPC_URL) throw new Error("MAINNET_RPC_URL required");
  provider ||= new providers.StaticJsonRpcProvider(env.MAINNET_RPC_URL);
  if ((await provider.getNetwork()).chainId !== 1) throw new Error("RPC is not Ethereum mainnet");
  const address = utils.getAddress(env.CONTRACT_ADDRESS), code = await provider.getCode(address);
  if (!code || code === "0x") throw new Error(`No contract deployed at ${address}`);
  const version = await new Contract(address, ["function executorVersion() view returns (uint256)"], provider).executorVersion()
    .then(v => v.toNumber(), () => null);
  if (version !== EXECUTOR_VERSION) throw new Error(`Executor at ${address} reports version ${version ?? "unknown"}; v${EXECUTOR_VERSION} required (redeploy)`);
  const hash = utils.keccak256(code), configured = env.EXPECTED_CONTRACT_CODE_HASH || null;
  return { address, executorVersion: version, codeHash: hash, configured, matches: configured ? configured.toLowerCase() === hash : false };
}

if (require.main === module) {
  loadEnvironment();
  codeHash().then(r => {
    console.log(`Executor ${r.address} (v${r.executorVersion})`);
    console.log(`EXPECTED_CONTRACT_CODE_HASH=${r.codeHash}`);
    console.log(r.configured ? (r.matches ? "Configured value matches." : `Configured value differs: ${r.configured}`) : "Not configured yet: add the line above to your env file.");
    if (!r.matches) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { codeHash };
