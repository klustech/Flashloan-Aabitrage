const fs = require("fs");
const path = require("path");
const { serialize } = require("../bot/units");
const { readJournal } = require("../bot/tradeLedger");
const ALLOWED = {
  DETECTED: ["POST_TRIGGER_QUOTED", "REJECTED"],
  POST_TRIGGER_QUOTED: ["FUNDING_SELECTED", "REJECTED"],
  FUNDING_SELECTED: ["SIMULATED", "REJECTED"],
  SIMULATED: ["SUBMITTED", "REJECTED"],
  SUBMITTED: ["INCLUDED", "REVERTED", "DROPPED"],
  REJECTED: [], INCLUDED: [], REVERTED: [], DROPPED: [],
};
class BackrunLedger {
  constructor({ file = process.env.BACKRUN_LEDGER_PATH || "runtime/backrun/records.jsonl", persist, limit = 2000 } = {}) {
    Object.assign(this, { file, persist, limit }); this.records = new Map();
    if (file && fs.existsSync(file)) {
      // Bounded restart read; full history remains in PostgreSQL/journal.
      const fd = fs.openSync(file, "r"), size = fs.fstatSync(fd).size, length = Math.min(size, 4 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
      let text = buffer.toString("utf8");
      if (size > length) text = text.slice(text.indexOf("\n") + 1);
      this.tornWrites = 0;
      for (const row of readJournal(text, this)) this.remember(row);
    }
  }
  remember(row) {
    this.records.delete(row.id); this.records.set(row.id, row);
    while (this.records.size > this.limit) this.records.delete(this.records.keys().next().value);
  }
  async write(record) {
    const previous = this.records.get(record.id);
    if (!ALLOWED[record.status] || (!previous && record.status !== "DETECTED") ||
      (previous && previous.status !== record.status && !ALLOWED[previous.status].includes(record.status)))
      throw new Error("Invalid backrun lifecycle");
    const row = serialize({ ...previous, ...record, updatedAt: Date.now() });
    // Never persist full raw order flow or transaction envelopes.
    delete row.rawTx; delete row.transaction;
    if (this.persist) await this.persist(row);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(this.file, "a", 0o600);
      try { fs.writeSync(fd, JSON.stringify(row) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    this.remember(row); return row;
  }
  recent(limit = 100) { return [...this.records.values()].reverse().slice(0, limit); }
}
module.exports = { BackrunLedger, ALLOWED };
