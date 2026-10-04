const { abortError } = require("../bot/asyncControl");

class BackrunScheduler {
  constructor({
    run,
    enabled = () => true,
    budgetMs = () => 4000,
    eventTtlMs = () => 12000,
    onError = () => {},
    maxSeen = 4096,
  }) {
    Object.assign(this,{run,enabled,budgetMs,eventTtlMs,onError,maxSeen});
    this.closed = true;
    this.running = false;
    this.pending = null;
    this.active = null;
    this.seen = new Map();
    this.stats = {
      received: 0,
      deduplicated: 0,
      expired: 0,
      superseded: 0,
      processed: 0,
      budgetExpired: 0,
      errors: 0,
    };
  }

  start() {
    this.closed = false;
    return this;
  }

  remember(hash, now) {
    if (!hash) return true;
    if (this.seen.has(hash)) return false;
    this.seen.set(hash, now);
    if (this.seen.size > this.maxSeen) {
      const remove = this.seen.size - this.maxSeen;
      let i=0;
      for (const key of this.seen.keys()) {
        this.seen.delete(key);
        if (++i >= remove) break;
      }
    }
    return true;
  }

  enqueue(trigger) {
    if (this.closed || !this.enabled()) return false;
    const now=Date.now();
    this.stats.received++;
    if (!this.remember(trigger?.hash,now)) {
      this.stats.deduplicated++;
      return false;
    }
    if (!trigger?.receivedAt) trigger={...trigger,receivedAt:now};
    if (now-trigger.receivedAt>this.eventTtlMs()) {
      this.stats.expired++;
      return false;
    }

    // A newer order-flow event supersedes work only while it is still in the
    // unsigned analysis phase. BackrunEngine flips committed=true immediately
    // before any signature is requested.
    if (this.pending) this.stats.superseded++;
    this.pending=trigger;
    if (this.active && !this.active.committed) {
      this.stats.superseded++;
      this.active.controller.abort(abortError("Newer trigger superseded analysis"));
    }
    if (!this.running) void this.drain();
    return true;
  }

  async drain() {
    this.running=true;
    try {
      while (!this.closed && this.pending) {
        const trigger=this.pending;
        this.pending=null;
        if (!this.enabled()) continue;
        if (Date.now()-trigger.receivedAt>this.eventTtlMs()) {
          this.stats.expired++;
          continue;
        }
        const controller=new AbortController();
        const active={controller,committed:false,trigger};
        this.active=active;
        const timer=setTimeout(()=>{
          if(!active.committed){
            this.stats.budgetExpired++;
            controller.abort(abortError("Backrun analysis budget expired"));
          }
        },this.budgetMs());
        timer.unref?.();
        try {
          await this.run({
            trigger,
            signal:controller.signal,
            markCommitted:()=>{active.committed=true;},
          });
          this.stats.processed++;
        } catch (err) {
          if (err?.name !== "AbortError") {
            this.stats.errors++;
            this.onError(err,trigger);
          }
        } finally {
          clearTimeout(timer);
          if(this.active===active)this.active=null;
        }
      }
    } finally {
      this.running=false;
    }
  }

  stop() {
    this.closed=true;
    this.pending=null;
    if(this.active&&!this.active.committed)this.active.controller.abort();
  }

  status() {
    return {
      ...this.stats,
      running:this.running,
      queued:Boolean(this.pending),
      activeHash:this.active?.trigger?.hash||null,
      committed:Boolean(this.active?.committed),
      seen:this.seen.size,
    };
  }
}

module.exports={BackrunScheduler};
