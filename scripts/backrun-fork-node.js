const {spawn}=require("child_process"),path=require("path");
const {loadEnvironment}=require("./paper-preflight");
loadEnvironment();
if(process.env.PRIVATE_KEY)throw new Error("Disposable fork node refuses PRIVATE_KEY");
const anvil=process.argv.includes("--anvil");
const tool=anvil?require("./backrun-anvil"):null;
const child=anvil?spawn(tool.anvilBinary(),tool.anvilArguments(),{stdio:"inherit",env:process.env}):
  spawn(process.execPath,[require.resolve("hardhat/internal/cli/cli"),"node","--config",
    path.join(__dirname,"../hardhat.backrun.config.js"),"--no-deploy","--hostname","127.0.0.1","--port","8547"],{stdio:"inherit",env:process.env});
child.on("error",()=>{console.error("Dedicated fork failed to start");process.exitCode=1;});

for(const event of ["SIGINT","SIGTERM"])process.once(event,()=>child.kill(event));
child.on("exit",code=>{process.exitCode=code===null?1:code;});
