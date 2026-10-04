const { BackrunEngine } = require("./backrunEngine");
const { BackrunScheduler } = require("./backrunScheduler");
const { MevShareStream } = require("./mevShareStream");
const { PublicPendingSource } = require("./publicPendingSource");

class BackrunService {
  constructor({ coordinator, engine, scheduler, sources } = {}) {
    if(!coordinator)throw new Error("BackrunService requires Coordinator");
    this.coordinator=coordinator;
    this.profile=coordinator.profile;
    this.engine=engine||new BackrunEngine({coordinator});
    this.scheduler=scheduler||new BackrunScheduler({
      run:options=>this.engine.handleTrigger(options),
      enabled:()=>["PAPER","LIVE_RUNNING"].includes(coordinator.state.state),
      budgetMs:()=>this.profile.backrun.budgetMs,
      eventTtlMs:()=>this.profile.backrun.eventTtlMs,
      onError:(err,trigger)=>coordinator.emit?.("backrun_error",{triggerHash:trigger?.hash,reason:err.message}),
    });
    this.sources=sources||this.buildSources();
    this.started=false;
  }

  buildSources(){
    const sources=[];
    if(this.profile.backrun.sources.includes("mev_share")){
      sources.push(new MevShareStream({url:this.profile.backrun.mevShareStreamUrl}));
    }
    if(this.profile.backrun.publicPendingEnabled||this.profile.backrun.sources.includes("public_pending")){
      const routers=Object.values(this.profile.routers).map(config=>config.router).filter(Boolean);
      sources.push(new PublicPendingSource({
        websocketUrl:process.env.MAINNET_WEBSOCKET,
        routers,
        extraRouters:this.profile.backrun.extraRouters,
      }));
    }
    return sources;
  }

  start(){
    if(this.started||!this.profile.backrun.enabled)return this;
    this.started=true;
    this.scheduler.start();
    for(const source of this.sources){
      source.on?.("trigger",trigger=>this.scheduler.enqueue(trigger));
      source.on?.("source_error",err=>this.coordinator.emit?.("backrun_source_error",{reason:err.message}));
      source.on?.("stream_error",err=>this.coordinator.emit?.("backrun_source_error",{reason:err.message}));
      source.start();
    }
    return this;
  }

  stop(){
    this.started=false;
    for(const source of this.sources)source.stop?.();
    this.scheduler.stop();
  }

  status(){
    return {
      started:this.started,
      engine:this.engine.status(),
      scheduler:this.scheduler.status(),
      sources:this.sources.map(source=>({
        type:source.constructor?.name||"source",
        ...(source.status?.()||{}),
      })),
    };
  }
}

module.exports={BackrunService};
