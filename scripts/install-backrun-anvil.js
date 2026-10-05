const fs = require("fs"), path = require("path"), os = require("os");
const { createHash } = require("crypto"), { execFileSync } = require("child_process");
const { VERSION, DIGESTS, platform, installPath } = require("./backrun-anvil");
function install() {
  const target = platform(), directory = installPath(), binary = path.join(directory, "anvil");
  if (fs.existsSync(binary)) { console.log("Pinned Anvil already installed: " + VERSION); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "backrun-anvil-"));
  try {
    const archive = path.join(temporary, "foundry.tar.gz");
    const url = "https://github.com/foundry-rs/foundry/releases/download/v" + VERSION +
      "/foundry_v" + VERSION + "_" + target + ".tar.gz";
    console.log("Downloading official Foundry " + VERSION + " (" + target + ")...");
    execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--max-time", "180", "--output", archive, url],
      { stdio: "inherit", timeout: 185000 });
    const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (digest !== DIGESTS[target]) throw new Error("Official Anvil release archive checksum mismatch");
    // Extract only the requested binary; do not install global Foundry tools.
    execFileSync("tar", ["-xzf", archive, "--no-same-owner", "-C", temporary, "anvil"], { stdio: "inherit" });
    const extracted = path.join(temporary, "anvil");
    if (!fs.lstatSync(extracted).isFile()) throw new Error("Expected a regular Anvil executable");
    fs.chmodSync(extracted, 0o700);
    const version = execFileSync(extracted, ["--version"], { encoding: "utf8", timeout: 10000 });
    if (!version.includes("Version: " + VERSION)) throw new Error("Unexpected Anvil release version");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.copyFileSync(extracted, binary + ".tmp"); fs.chmodSync(binary + ".tmp", 0o700); fs.renameSync(binary + ".tmp", binary);
    console.log("Installed checksum-verified Anvil " + VERSION + ".");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (require.main === module) { try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { install };
