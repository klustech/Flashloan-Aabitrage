const fs=require('fs');
const path=require('path');
class PaperBurnIn {
  constructor(profile,{file=process.env.PAPER_BURN_IN_PATH||'runtime/paper-burn-in.json',maxGapMs=180000}={}){this.profile=profile;this.file=file;this.maxGapMs=maxGapMs;this.data=null;if(fs.existsSync(file))this.data=JSON.parse(fs.readFileSync(file,'utf8'));}
  record(result,now=Date.now()){
    let data=this.data;
    if(!data||data.profileFingerprint!==this.profile.fingerprint||now-data.lastHeartbeat>this.maxGapMs)data={profileFingerprint:this.profile.fingerprint,startedAt:now,lastHeartbeat:now,cycles:0,simulated:0,rejections:{},continuousMs:0};
    data.cycles++;data.lastHeartbeat=now;data.continuousMs=now-data.startedAt;
    if(result?.simulated)data.simulated++;if(result?.reason)data.rejections[result.reason]=(data.rejections[result.reason]||0)+1;
    data.passed=data.continuousMs>=7*86400000&&data.simulated>0;
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});fs.writeFileSync(this.file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.data=data;return data;
  }
}
module.exports={PaperBurnIn};
