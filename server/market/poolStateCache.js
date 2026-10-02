const fs = require('fs');
const path = require('path');
const { PoolRegistry, edge } = require('./poolRegistry');
const { address, serialize } = require('../bot/units');
const { checkSignal, abortable, mapLimit } = require('../bot/asyncControl');

// Persist topology only. Restarted processes always verify metadata and read
// fresh on-chain state before any candidate can use a saved pool.
class PoolStateCache {
  constructor({ provider, adapters, tokens, profile, file = process.env.POOL_CACHE_PATH || 'runtime/pool-topology.json' }) {
    Object.assign(this, { provider, adapters, tokens, profile, file });
    this.registry = new PoolRegistry(tokens);
    this.head = null;
    this.discoveredAtBlock = null;
    this.stats = { discoveryRuns: 0, stateReads: 0, logRequests: 0, reusedPools: 0, reorgs: 0, logFallbacks: 0 };
  }
  async discover(block, signal) {
    const tokenAddresses = this.profile.tokenSymbols.map(s => address(this.profile.tokens[s]));
    const registry = new PoolRegistry(this.tokens);
    const pools = await mapLimit(Object.values(this.adapters), 4, a => a.discoverPools(tokenAddresses, block.number, signal), signal);
    for (const list of pools) for (const pool of list) registry.add(pool);
    checkSignal(signal);
    return registry;
  }
  loadTopology(block) {
    if (!this.file || !fs.existsSync(this.file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.profileFingerprint !== this.profile.fingerprint || !Array.isArray(data.pools)) return null;
      if (!Number.isSafeInteger(data.discoveredAtBlock) || data.discoveredAtBlock > block.number || block.number-data.discoveredAtBlock >= (this.profile.poolDiscoveryIntervalBlocks || 300)) return null;
      const registry = new PoolRegistry(this.tokens);
      for (const pool of data.pools) {
        const config = this.profile.routers[pool.dex];
        if (!config || address(pool.router) !== address(config.router) || address(pool.factory) !== address(config.factory)) return null;
        if (pool.protocolVersion === 3 && (address(pool.quoter) !== address(config.quoter) || !config.feeTiers.includes(pool.feeTier))) return null;
        registry.add(pool);
      }
      this.loadedDiscoveryBlock=data.discoveredAtBlock;return registry;
    } catch (_) { return null; }
  }
  saveTopology(registry, block) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const pools=registry.values().map(p=>Object.fromEntries(['chainId','dex','poolAddress','router','factory','quoter','token0','token1','protocolVersion','feeTier','feeBps'].filter(key=>p[key]!==undefined).map(key=>[key,p[key]])));
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(serialize({ profileFingerprint: this.profile.fingerprint, discoveredAtBlock: block.number, pools })), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  async readStates(registry, pools, block, signal, verifyMetadata = false) {
    const states = await mapLimit(pools, this.profile.rpcConcurrency || 8, async pool => {
      const adapter = this.adapters[pool.dex];
      const read = !verifyMetadata && adapter.getDynamicState ? adapter.getDynamicState.bind(adapter) : adapter.getPoolState.bind(adapter);
      const state = await read(pool, block.number);
      if (verifyMetadata && (address(state.token0) !== pool.token0 || address(state.token1) !== pool.token1)) throw new Error('Cached pool token metadata changed');
      if (verifyMetadata) await adapter.validatePool(edge(pool, pool.token0), block.number);
      return { ...pool, ...state };
    }, signal);
    for (const pool of states) registry.add(pool);
    return states.length;
  }
  async sync(block, { signal } = {}) {
    checkSignal(signal);
    if (this.head?.hash === block.hash) return { registry: this.registry, changedPools: new Set(), ...this.stats };
    const oldHead = this.head;
    let registry, discovered = false, reorg = false, logFallback = false, changed = new Set(), reads = 0;
    let fullRefresh = !oldHead;
    if (oldHead) {
      const previous = block.number === oldHead.number + 1 ? block.parentHash : (await abortable(this.provider.getBlock(oldHead.number), signal))?.hash;
      reorg = block.number <= oldHead.number || previous !== oldHead.hash;
      fullRefresh = reorg || block.number - oldHead.number > (this.profile.maxCachedBlockGap || 64);
    }
    const rediscover = !oldHead || block.number - this.discoveredAtBlock >= (this.profile.poolDiscoveryIntervalBlocks || 300);
    if (rediscover) {
      registry = !oldHead ? this.loadTopology(block) : null;
      if(registry&&this.loadedDiscoveryBlock<block.number){
        // Catch pools created while this process was offline before extending
        // the discovery epoch of a persisted topology.
        try {this.stats.logRequests++;const logs=await abortable(this.provider.getLogs({address:[...new Set(Object.values(this.profile.routers).map(c=>address(c.factory)))],fromBlock:this.loadedDiscoveryBlock+1,toBlock:block.number}),signal);if(logs.length)registry=null;}
        catch(err){checkSignal(signal);registry=null;}
      }
      if (registry && registry.values().length) reads += await this.readStates(registry, registry.values(), block, signal, true);
      else { registry = await this.discover(block, signal); discovered = true; reads += registry.values().length; }
      for (const p of registry.values()) changed.add(p.poolAddress);
    } else {
      registry = new PoolRegistry(this.tokens);
      for (const pool of this.registry.values()) registry.add(pool);
      if (!fullRefresh) {
        const factories = new Set(Object.values(this.profile.routers).map(c => address(c.factory)));
        const addresses = [...new Set([...registry.values().map(p => p.poolAddress), ...factories])];
        const chunks = []; for (let i = 0; i < addresses.length; i += 100) chunks.push(addresses.slice(i, i + 100));
        try {
          const lists = await mapLimit(chunks, this.profile.rpcConcurrency || 8, async list => {
            this.stats.logRequests++;
            return this.provider.getLogs({ address: list, fromBlock: oldHead.number + 1, toBlock: block.number });
          }, signal);
          let created = false;
          for (const log of lists.flat()) {
            if (log.removed || log.blockNumber < oldHead.number + 1 || log.blockNumber > block.number) throw new Error('Noncanonical pool logs');
            if (log.blockNumber === block.number && log.blockHash !== block.hash) throw new Error('Pool log block hash mismatch');
            if (factories.has(address(log.address))) created = true;
            else changed.add(address(log.address));
          }
          if (created) { registry = await this.discover(block, signal); discovered = true; reads += registry.values().length; for (const p of registry.values()) changed.add(p.poolAddress); }
        } catch (err) { checkSignal(signal); fullRefresh = true; logFallback = true; }
      }
      if (!discovered) {
        const pools = registry.values().filter(p => fullRefresh || changed.has(p.poolAddress));
        reads += await this.readStates(registry, pools, block, signal);
        if (fullRefresh) for (const p of registry.values()) changed.add(p.poolAddress);
      }
    }
    // A state carried forward is current only because a complete canonical log
    // range proved that its pool did not change. RPC/log failures read all pools.
    for (const pool of registry.values()) registry.add({ ...pool, stateBlock: block.number, stateTimestamp: Date.now() });
    const canonical = await abortable(this.provider.getBlock(block.number), signal);
    if (!canonical || canonical.hash !== block.hash) throw new Error('Cache snapshot reorganized');
    checkSignal(signal);
    if (discovered || rediscover) this.saveTopology(registry, block);
    this.registry = registry; this.head = block;
    if (discovered || rediscover) this.discoveredAtBlock = block.number;
    this.stats.discoveryRuns += Number(discovered); this.stats.stateReads += reads;
    this.stats.reusedPools = registry.values().length - reads;
    this.stats.reorgs += Number(reorg); this.stats.logFallbacks += Number(logFallback);
    return { registry, changedPools: changed, ...this.stats };
  }
  status() { return { ...this.stats, pools: this.registry.values().length, block: this.head?.number, blockHash: this.head?.hash }; }
}
module.exports = { PoolStateCache };
