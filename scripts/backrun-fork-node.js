const {spawn}=require("child_process"),path=require("path");
const {loadEnvironment}=require("./paper-preflight");
loadEnvironment();
if(process.env.PRIVATE_KEY)throw new Error("Disposable fork node refuses PRIVATE_KEY");
const child=spawn(process.execPath,[require.resolve("hardhat/internal/cli/cli"),"node","--config",
  path.join(__dirname,"../hardhat.backrun.config.js"),"--no-deploy","--hostname","127.0.0.1","--port","8547"],{stdio:"inherit",env:process.env});
for(const event of ["SIGINT","SIGTERM"])process.once(event,()=>child.kill(event));
child.on("exit",code=>{process.exitCode=code||0;});
