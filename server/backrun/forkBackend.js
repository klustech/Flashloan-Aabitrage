const { providers, utils } = require("ethers");
const { bn, address } = require("../bot/units");
const { checkSignal } = require("../bot/asyncControl");
const { validateRaw, validateCanonicalRaw } = require("./rawTransaction");
const fs=require("fs"),path=require("path"),{randomUUID}=require("crypto");
const instrumentedProviders = new WeakSet();
function instrumentForkRpc(provider) {
  if (typeof provider.send !== "function" || instrumentedProviders.has(provider)) return provider;
  const send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    try { return await send(method, params); }
    catch (error) {
      // Record method/schema metadata only; fork requests can contain archive
      // credentials, raw signed transactions or executor calldata.
      try {
        error.forkRpcMethod = method;
        error.forkRpcParameterTypes = Array.isArray(params) ? params.slice(0, 8).map(value =>
          Array.isArray(value) ? "array" : value === null ? "null" : typeof value) : [];
      } catch (_) {}
      throw error;
    }
  };
  instrumentedProviders.add(provider);
  return provider;
}
function assertLocalForkUrl(url) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    throw new Error("Backrun fork RPC must be a dedicated loopback node");
}
function nextBaseFee(block) {
  const base = bn(block.baseFeePerGas), target = bn(block.gasLimit).div(2), used = bn(block.gasUsed);
  if (used.eq(target)) return base;
  const delta = base.mul(used.sub(target).abs()).div(target).div(8);
  return used.gt(target) ? base.add(delta.gt(0) ? delta : 1) : base.sub(delta);
}
async function latestBlock(provider) {
  const raw = await provider.send("eth_getBlockByNumber", ["latest", false]);
  return provider.formatter.block(raw);
}
class ForkBackend {
  constructor({ url, archiveUrl, provider, clock = Date.now, engine = "hardhat" }) {
    assertLocalForkUrl(url);
    if (!["hardhat", "anvil"].includes(engine)) throw new Error("Unsupported dedicated fork engine");
    Object.assign(this, { url, archiveUrl, clock, engine });
    this.blobReplayAccounts = new Set();
    this.provider = instrumentForkRpc(provider || new providers.StaticJsonRpcProvider({ url, timeout: 30000 }, 1));
    this.tail = Promise.resolve();
    this.lockFile=path.resolve(process.env.BACKRUN_LOCK_DIR||"runtime/backrun","fork-"+new URL(url).port+".lock");
  }
  async exclusive(work, signal) {
    const before = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await before;
    const token=randomUUID();let locked=false;
    try {
      checkSignal(signal);fs.mkdirSync(path.dirname(this.lockFile),{recursive:true,mode:0o700});
      const started=Date.now();
      while(!locked){
        checkSignal(signal);
        try{fs.writeFileSync(this.lockFile,JSON.stringify({pid:process.pid,token}),{flag:"wx",mode:0o600});locked=true;}
        catch(e){
          if(e.code!=="EEXIST")throw e;
          try{const owner=JSON.parse(fs.readFileSync(this.lockFile,"utf8"));try{process.kill(owner.pid,0);}catch(error){if(error.code==="ESRCH")fs.unlinkSync(this.lockFile);}}catch(_){}
          if(Date.now()-started>30000)throw new Error("Dedicated fork is busy in another process");
          await new Promise(resolve=>setTimeout(resolve,50));
        }
      }
      return await work();
    } finally {
      if(locked){try{if(JSON.parse(fs.readFileSync(this.lockFile,"utf8")).token===token)fs.unlinkSync(this.lockFile);}catch(_){}}
      release();
    }
  }
  async verify() {
    const [client, chain] = await Promise.all([this.provider.send("web3_clientVersion", []), this.provider.send("eth_chainId", [])]);
    const expected = this.engine === "anvil" ? /^anvil\//i : /^HardhatNetwork\//;
    if (!expected.test(client) || Number(chain) !== 1)
      throw new Error("Dedicated " + (this.engine === "anvil" ? "Anvil" : "Hardhat") + " fork with chainId 1 required");
    if (this.engine === "anvil") {
      const version = client.match(/^anvil\/v?(\d+)\.(\d+)\.(\d+)/i), minimum = [1, 8, 4];
      const parts = version?.slice(1).map(Number);
      const difference = parts?.map((part, i) => part - minimum[i]).find(part => part !== 0);
      if (!parts || (difference !== undefined && difference < 0))
        throw new Error("Anvil 1.8.4 or newer required for canonical PREVRANDAO replay; run backrun:install-anvil");
    }
    return { clientVersion: client.match(/^(?:HardhatNetwork|anvil)\/v?\d+\.\d+\.\d+/i)?.[0] || this.engine, chainId: Number(chain) };
  }
  async reset(block, signal) {
    checkSignal(signal); await this.verify();
    if (!this.archiveUrl) throw new Error("Archive RPC required for trigger simulation");
    await this.provider.send("hardhat_reset", [{ forking: { jsonRpcUrl: this.archiveUrl, blockNumber: block.number } }]);
    const parent = await latestBlock(this.provider);
    if (parent.hash.toLowerCase() !== block.hash.toLowerCase()) throw new Error("Fork parent block mismatch");
    await this.provider.send("evm_setAutomine", [false]);
    checkSignal(signal);
  }
  async configureBlock(block) {
    await this.provider.send("evm_setNextBlockTimestamp", [block.timestamp]);
    await this.provider.send("hardhat_setNextBlockBaseFeePerGas", [utils.hexValue(block.baseFeePerGas)]);
    await this.provider.send("evm_setBlockGasLimit", [utils.hexValue(block.gasLimit)]);
    if (block.miner) await this.provider.send("hardhat_setCoinbase", [block.miner]);
    if (block.mixHash) await this.provider.send(this.engine === "anvil" ? "anvil_setNextBlockPrevRandao" : "hardhat_setPrevRandao", [block.mixHash]);
  }
  async submitRaw(raw, block, index, canonicalTransaction) {
    const hash = utils.keccak256(raw);
    const parsed = canonicalTransaction ? validateCanonicalRaw(raw, canonicalTransaction) : validateRaw(raw, hash);
    try {
      if (canonicalTransaction && parsed.type === 3) {
        if (this.engine !== "anvil") {
          const error = new Error("Hardhat cannot mine an ordered blob prefix; run backrun:replay with --local --anvil");
          error.code = "BACKRUN_BLOB_REPLAY_REQUIRES_ANVIL"; throw error;
        }
        // This is execution-only replay of an already canonical, authenticated
        // signed body. Scoped impersonation bypasses sidecar availability/KZG
        // checks on the local node, while the ORIGINAL signature, transaction
        // hash, type, blob hashes, gas fees and execution are retained.
        await this.provider.send("anvil_impersonateAccount", [parsed.from]);
        this.blobReplayAccounts.add(parsed.from);
      }
      const accepted = await this.provider.send("eth_sendRawTransaction", [raw]);
      if (accepted.toLowerCase() !== hash.toLowerCase()) throw new Error("Fork accepted a different transaction");
      return hash;
    } catch (error) {
      try { error.replayTransactionIndex = index; error.replayTransactionType = Number(parsed.type ?? 0); } catch (_) {}
      throw error;
    }
  }
  async clearBlobReplayAccounts() {
    const accounts = [...this.blobReplayAccounts]; this.blobReplayAccounts.clear();
    const results = await Promise.allSettled(accounts.map(account => this.provider.send("anvil_stopImpersonatingAccount", [account])));
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  async mine(rawTransactions, block, { signal, canonicalTransactions } = {}) {
    if (canonicalTransactions !== undefined && (!Array.isArray(canonicalTransactions) || canonicalTransactions.length !== rawTransactions.length))
      throw new Error("Canonical prefix transaction count mismatch");
    checkSignal(signal); await this.configureBlock(block);
    const expected = [];
    try {
      for (const raw of rawTransactions) {
        checkSignal(signal);
        expected.push(await this.submitRaw(raw, block, expected.length, canonicalTransactions?.[expected.length]));
      }
      checkSignal(signal); await this.provider.send("evm_mine", []);
      const mined = await latestBlock(this.provider);
      if (mined.number !== block.number || mined.transactions.length !== expected.length ||
          expected.some((h, i) => h.toLowerCase() !== mined.transactions[i].toLowerCase()))
        throw new Error("Fork transaction order/inclusion mismatch");
      const receipts = [];
      for (const hash of expected) receipts.push(await this.provider.getTransactionReceipt(hash));
      return { block: mined, receipts };
    } finally { await this.clearBlobReplayAccounts(); }
  }
  async applyTrigger(trigger, parent, signal) {
    validateRaw(trigger.rawTx, trigger.hash);
    await this.reset(parent, signal);
    const header = { ...parent, number: parent.number + 1, timestamp: parent.timestamp + 12,
      baseFeePerGas: nextBaseFee(parent), miner: parent.miner };
    const result = await this.mine([trigger.rawTx], header, { signal });
    if (result.receipts[0]?.status !== 1) throw new Error("Trigger transaction reverted");
    return { ...result, header, triggerReceipt: result.receipts[0] };
  }
  async simulateUnsignedBundle({ trigger, parent, header, transaction, signal }) {
    return this.simulateUnsignedPrefix({ rawTransactions:[trigger.rawTx],parent,header,transaction,signal });
  }
  async simulateUnsignedPrefix({rawTransactions,parent,header,transaction,signal,canonicalTransactions}) {
    if (canonicalTransactions !== undefined && (!Array.isArray(canonicalTransactions) || canonicalTransactions.length !== rawTransactions.length))
      throw new Error("Canonical prefix transaction count mismatch");
    const prefix=await latestBlock(this.provider),expectedPrefix=rawTransactions.map(utils.keccak256);
    if(prefix.number!==header.number||prefix.transactions.length!==expectedPrefix.length||
      expectedPrefix.some((h,i)=>prefix.transactions[i].toLowerCase()!==h.toLowerCase()))
      throw new Error("Post-trigger prefix context mismatch");
    const coinbaseBeforeBackrun=await this.provider.getBalance(header.miner,prefix.number);
    // Use the unsigned operator call only on this isolated fork. No wallet,
    // eth_sign or signTransaction is involved, and no mainnet RPC is mutated.
    await this.reset(parent, signal); await this.configureBlock(header);
    const expected=[];
    try {
      for(const raw of rawTransactions){
        checkSignal(signal);
        expected.push(await this.submitRaw(raw, header, expected.length, canonicalTransactions?.[expected.length]));
      }
      const triggerHash=expected.at(-1);
      const from = address(transaction.from);
      await this.provider.send("hardhat_impersonateAccount", [from]);
      try {
        const tx = { from, to: transaction.to, data: transaction.data, value: "0x0",
          gas: utils.hexValue(transaction.gasLimit), maxFeePerGas: utils.hexValue(transaction.maxFeePerGas),
          maxPriorityFeePerGas: utils.hexValue(transaction.maxPriorityFeePerGas), type: "0x2" };
        const backrunHash = await this.provider.send("eth_sendTransaction", [tx]);
        checkSignal(signal); await this.provider.send("evm_mine", []);
        const block = await latestBlock(this.provider);
        if (block.number !== header.number || block.transactions.length !== expected.length+1 ||
            expected.some((h,i)=>block.transactions[i].toLowerCase()!==h.toLowerCase()) ||
            block.transactions.at(-1).toLowerCase() !== backrunHash.toLowerCase())
          throw new Error("Unsigned fork bundle order mismatch");
        const [triggerReceipt, backrunReceipt] = await Promise.all([
          this.provider.getTransactionReceipt(triggerHash), this.provider.getTransactionReceipt(backrunHash)]);
        if (triggerReceipt.status !== 1 || backrunReceipt.status !== 1) throw new Error("Ordered fork bundle reverted");
        const coinbaseAfter=await this.provider.getBalance(header.miner,block.number);
        const priority=bn(backrunReceipt.effectiveGasPrice).sub(block.baseFeePerGas).mul(backrunReceipt.gasUsed);
        const directCoinbaseDelta=coinbaseAfter.sub(coinbaseBeforeBackrun).sub(priority);
        if(!directCoinbaseDelta.isZero())throw new Error("Unexpected net direct coinbase payment");
        const prefixReceipts=[];
        for(const hash of expected)prefixReceipts.push(await this.provider.getTransactionReceipt(hash));
        return { kind: "UNSIGNED_FORK_BUNDLE", signed: false, submitted: false, parentBlock: parent.number,
          parentHash: parent.hash, targetBlock: header.number, triggerHash, backrunHash,
          gasUsed: backrunReceipt.gasUsed, triggerGasUsed: triggerReceipt.gasUsed, backrunReceipt,prefixReceipts,
          simulatedAt: this.clock(), directCoinbasePayment:directCoinbaseDelta.toString(),
          directCoinbaseAccounting:"same-header prefix/bundle native balance delta minus backrun priority fee" };
      } finally { await this.provider.send("hardhat_stopImpersonatingAccount", [from]); }
    } finally { await this.clearBlobReplayAccounts(); }
  }
}
module.exports = { ForkBackend, assertLocalForkUrl, nextBaseFee, latestBlock };
