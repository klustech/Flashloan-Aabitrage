const https=require('node:https');
const {EventEmitter}=require('node:events');

class MevShareSource extends EventEmitter {
  constructor({
    url='https://mev-share.flashbots.net',
    reconnectMs=1000,
    maxReconnectMs=30000,
    request=https.get,
  }={}){
    super();
    Object.assign(this,{url,reconnectMs,maxReconnectMs,request});
    this.closed=true;
    this.req=null;
    this.res=null;
    this.retryMs=reconnectMs;
    this.stats={connections:0,reconnects:0,events:0,parseErrors:0,lastEventAt:null,lastError:null};
  }

  start(){
    if(!this.closed)return this;
    this.closed=false;
    this.connect();
    return this;
  }

  stop(){
    this.closed=true;
    if(this.req?.destroy)this.req.destroy();
    if(this.res?.destroy)this.res.destroy();
    clearTimeout(this.timer);
    this.req=this.res=null;
  }

  schedule(error){
    if(this.closed)return;
    if(error){
      this.stats.lastError=error.message||String(error);
      this.emit('source_error',error);
    }
    clearTimeout(this.timer);
    const wait=this.retryMs;
    this.retryMs=Math.min(this.maxReconnectMs,Math.max(this.reconnectMs,this.retryMs*2));
    this.stats.reconnects++;
    this.timer=setTimeout(()=>this.connect(),wait);
    this.timer.unref?.();
  }

  handleEvent(raw){
    if(raw.length>1048576){this.stats.parseErrors++;this.emit('source_error',new Error('MEV-Share event exceeds limit'));return;}
    const lines=raw.split(/\r?\n/);
    const data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
    if(!data)return;
    try{
      const event=JSON.parse(data);
      if(!event?.hash)return;
      this.stats.events++;
      this.stats.lastEventAt=Date.now();
      this.emit('hint',{
        hash:String(event.hash).toLowerCase(),
        logs:Array.isArray(event.logs)?event.logs:[],
        txs:Array.isArray(event.txs)?event.txs:[],
        mevGasPrice:event.mevGasPrice,
        gasUsed:event.gasUsed,
        source:'mev_share',
        receivedAt:Date.now(),
      });
    }catch(error){
      this.stats.parseErrors++;
      this.stats.lastError=error.message;
      this.emit('source_error',error);
    }
  }

  connect(){
    if(this.closed)return;
    let settled=false;
    const req=this.request(this.url,{headers:{accept:'text/event-stream','cache-control':'no-cache'}},res=>{
      settled=true;
      this.res=res;
      if(res.statusCode!==200){
        res.resume?.();
        this.schedule(new Error(`MEV-Share stream HTTP ${res.statusCode}`));
        return;
      }
      this.stats.connections++;
      this.stats.lastError=null;
      this.retryMs=this.reconnectMs;
      let buffer='';
      res.setEncoding('utf8');
      res.on('data',chunk=>{
        buffer+=chunk;
        if(buffer.length>1048576){res.destroy();this.schedule(new Error('MEV-Share stream buffer exceeds limit'));return;}
        let idx;
        while((idx=buffer.search(/\r?\n\r?\n/))>=0){
          const block=buffer.slice(0,idx);
          const sep=buffer.match(/\r?\n\r?\n/);
          buffer=buffer.slice(idx+(sep?.[0]?.length||2));
          this.handleEvent(block);
        }
      });
      res.on('end',()=>this.schedule(new Error('MEV-Share stream ended')));
      res.on('error',error=>this.schedule(error));
    });
    this.req=req;
    req.on?.('error',error=>{if(!settled)this.schedule(error);});
  }

  status(){return {...this.stats,connected:Boolean(!this.closed&&this.res&&this.res.statusCode===200&&!this.res.destroyed),closed:this.closed};}
}

module.exports={MevShareSource};
