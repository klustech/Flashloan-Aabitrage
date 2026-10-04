const fs = require("fs"), path = require("path");
const VERSION = "1.8.4";
const DIGESTS = {
  linux_amd64: "699e2207a6a9b27ca17c48c81e56f1677ed9c58b623b59128b4e15ec9da0625e",
  linux_arm64: "d998f88314c057dc37c1de9a2044f49b273505965ff94bea5c3c5aefa9d1debd",
  darwin_amd64: "a4ba162f6e3677878b717643fcb247c7dbe31e8007c7645564626161cb7d2053",
  darwin_arm64: "b6a1b35d85c6b7dbe4b34ccf6c389407d530f906b56c319a5c74c7eec854de3b",
};
function platform() {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch], target = process.platform + "_" + arch;
  if (!DIGESTS[target]) throw new Error("Backrun Anvil installer supports Linux/WSL and macOS on x64/arm64");
  return target;
}
function installPath() { return path.join(__dirname, "../runtime/backrun/tools", "anvil-" + VERSION + "-" + platform()); }
function anvilBinary() {
  const binary = process.env.BACKRUN_ANVIL_BIN || path.join(installPath(), "anvil");
  if (!fs.existsSync(binary)) throw new Error("Anvil replay backend missing; run npm run backrun:install-anvil");
  return binary;
}
function anvilArguments() {
  return ["--host", "127.0.0.1", "--port", "8548", "--chain-id", "1", "--accounts", "0",
    "--no-mining", "--order", "fifo", "--disable-default-create2-deployer", "--silent"];
}
module.exports = { VERSION, DIGESTS, platform, installPath, anvilBinary, anvilArguments };
