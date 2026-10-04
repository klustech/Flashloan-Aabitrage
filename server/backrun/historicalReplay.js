const { bn, address, serialize } = require("../bot/units");
const { rawTransaction } = require("./rawTransaction");
function normalizedLogs(logs) {
  return logs.map(l => ({ address: l.address.toLowerCase(), data: l.data.toLowerCase(),
    topics: l.topics.map(t => t.toLowerCase()) }));
}
function verifyReceipts(actual, expected) {
  if (actual.length !== expected.length) throw new Error("Historical receipt count mismatch");
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i], e = expected[i];
    if (!a || !e || a.transactionHash.toLowerCase() !== e.transactionHash.toLowerCase() ||
      a.transactionIndex !== e.transactionIndex || a.status !== e.status || !bn(a.gasUsed).eq(e.gasUsed) ||
      JSON.stringify(normalizedLogs(a.logs)) !== JSON.stringify(normalizedLogs(e.logs)))
      throw new Error("Historical receipt/status/gas/log mismatch at transaction " + i);
  }
}
class HistoricalReplay {
  constructor({ archive, backend }) { Object.assign(this, { archive, backend }); this.cache = new Map(); }
  async block(number) {
    if (this.cache.has(number)) return this.cache.get(number);
    const [block, rawHeader] = await Promise.all([this.archive.getBlockWithTransactions(number),
      this.archive.send("eth_getBlockByNumber", ["0x" + number.toString(16), false])]);
    if (!block?.hash || !rawHeader?.hash || block.hash !== rawHeader.hash) throw new Error("Historical block unavailable");
    const parent = await this.archive.getBlock(number - 1);
    if (parent.hash !== block.parentHash) throw new Error("Historical parent mismatch");
    const raw = [], receipts = [];
    for (const tx of block.transactions) {
      raw.push(await rawTransaction(this.archive, tx));
      receipts.push(await this.archive.getTransactionReceipt(tx.hash));
    }
    const data = { block: { ...block, mixHash: rawHeader.mixHash }, parent, raw, receipts };
    this.cache.clear(); this.cache.set(number, data); return data;
  }
  async prefix(data, endIndex, work, signal) {
    if (!Number.isInteger(endIndex) || endIndex < -1 || endIndex >= data.raw.length)
      throw new Error("Historical prefix outside block");
    return this.backend.exclusive(async () => {
      await this.backend.reset(data.parent, signal);
      let block = data.parent, receipts = [];
      if (endIndex >= 0) {
        const result = await this.backend.mine(data.raw.slice(0, endIndex + 1), data.block, { signal });
        block = result.block; receipts = result.receipts;
        verifyReceipts(receipts, data.receipts.slice(0, endIndex + 1));
      }
      return work({ provider: this.backend.provider, block, receipts, raw: data.raw.slice(0, endIndex + 1) });
    }, signal);
  }
  async caseStudy(fixture, quoteRoute) {
    const data = await this.block(fixture.targetBlock), t = fixture.triggerTransactionIndex, a = fixture.arbitrageTransactionIndex;
    if (a !== t + 1 || data.block.transactions[t]?.hash.toLowerCase() !== fixture.triggerTransaction.toLowerCase() ||
        data.block.transactions[a]?.hash.toLowerCase() !== fixture.arbitrageTransaction.toLowerCase())
      throw new Error("Fixture transactions/order do not match canonical block");
    const preBlock = await this.prefix(data, -1, quoteRoute);
    const before = await this.prefix(data, t - 1, quoteRoute);
    const afterTrigger = await this.prefix(data, t, quoteRoute);
    const afterArbitrage = await this.prefix(data, a, quoteRoute);
    const input = bn(fixture.amountIn), grossBefore = bn(before).sub(input), grossAfter = bn(afterTrigger).sub(input);
    const grossCorrected = bn(afterArbitrage).sub(input), toleranceBps = Number(fixture.quoteToleranceBps ?? 1);
    const expectedAfter = bn(fixture.actualFinalAmount), expectedPre = bn(fixture.preBlockExpectedFinalAmount);
    const within = (actual, expected) => bn(actual).sub(expected).abs().mul(10000).lte(expected.mul(toleranceBps));
    const passed = bn(preBlock).lt(input) && grossBefore.lte(0) && grossAfter.gt(0) &&
      grossCorrected.mul(10000).lte(grossAfter.mul(Number(fixture.maxRemainingEdgeBps ?? 2500))) &&
      within(preBlock, expectedPre) && within(afterTrigger, expectedAfter);
    return serialize({ kind: "CANONICAL_INTRA_BLOCK_REPLAY", fixture: fixture.name, chainId: 1,
      blockNumber: data.block.number, blockHash: data.block.hash, parentHash: data.parent.hash,
      triggerHash: fixture.triggerTransaction, arbitrageHash: fixture.arbitrageTransaction,
      intraBlock: true, canonicalReceiptsVerified: true, prefixTransactions: a + 1,
      quoteToleranceBps: toleranceBps, inputAmount: input,
      stages: { preBlock: { finalAmount: preBlock, gross: bn(preBlock).sub(input) },
        beforeTrigger: { transactionIndex: t - 1, finalAmount: before, gross: grossBefore },
        afterTrigger: { transactionIndex: t, finalAmount: afterTrigger, gross: grossAfter },
        afterArbitrage: { transactionIndex: a, finalAmount: afterArbitrage, gross: grossCorrected } },
      passed, recordedAt: Date.now() });
  }
}
module.exports = { HistoricalReplay, verifyReceipts, normalizedLogs };
