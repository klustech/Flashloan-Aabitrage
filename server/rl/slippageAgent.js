const fs = require("fs");
const path = require("path");

const { promises: fsp } = fs;

class SlippageAgent {
  constructor({
    storagePath = path.resolve(__dirname, "slippage_data.json"),
    continuous = false,
    maxOffsetBips = 40,
    discreteActions = [-20, -10, 0, 10, 20, 40],
    epsilonStart = 0.2,
    epsilonMin = 0.05,
    epsilonDecay = 0.995,
    alpha = 0.2,
    saveDebounceMs = 200,
    metrics = {},
    logger = console,
  } = {}) {
    this.file = storagePath;
    this.continuous = Boolean(continuous);
    this.maxOffset = Number(maxOffsetBips);
    this.discreteActions = Array.isArray(discreteActions)
      ? [...discreteActions]
      : [-20, -10, 0, 10, 20, 40];
    this.actions = this.continuous ? [] : [...this.discreteActions];
    this.initialEpsilon = Number(epsilonStart);
    this.epsilon = this.initialEpsilon;
    this.minEpsilon = Number(epsilonMin);
    this.decay = Number(epsilonDecay);
    this.alpha = Number(alpha);
    this.saveDebounceMs = Number(saveDebounceMs);
    this.metrics = metrics;
    this.logger = logger || console;
    this.q = {};
    this.lastAction = null;
    this.lastSlippage = null;
    this.pendingWrite = null;
    this.debounceTimer = null;
    this.writePromise = Promise.resolve();
    this.lastPersistError = null;
    this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          this.q = parsed;
        } else {
          this.q = {};
        }
      } catch (err) {
        this.logger?.warn?.(
          `Failed to parse slippage policy file: ${err.message}. Falling back to defaults.`
        );
        this.q = {};
      }
    } else {
      this.q = {};
    }

    if (!this.continuous) {
      this.actions.forEach((a) => {
        if (!this.q[a]) this.q[a] = { value: 0, count: 0 };
      });
    }
  }

  queueSave() {
    this.pendingWrite = JSON.stringify(this.q, null, 2);
    if (this.debounceTimer) {
      return;
    }

    this.debounceTimer = setTimeout(() => {
      const payload = this.pendingWrite;
      this.pendingWrite = null;
      this.debounceTimer = null;
      this.writePromise = this.writePromise
        .catch(() => {})
        .then(() => this.persist(payload));
    }, this.saveDebounceMs);
  }

  async persist(payload) {
    if (typeof payload !== "string") {
      return;
    }
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(this.file, payload, "utf8");
      this.lastPersistError = null;
    } catch (err) {
      this.lastPersistError = err;
      this.logger?.error?.(
        `Failed to persist slippage policy: ${err.message}`
      );
      this.metrics?.rlAction?.set?.(-1);
      this.metrics?.rlEpsilon?.set?.(-1);
    }
  }

  select(baseBips) {
    if (this.continuous) {
      if (Math.random() < this.epsilon || !Object.keys(this.q).length) {
        this.lastAction = (Math.random() * 2 - 1) * this.maxOffset;
      } else {
        const bestKey = Object.keys(this.q).reduce((b, k) =>
          this.q[k].value > this.q[b].value ? k : b
        );
        this.lastAction = parseFloat(bestKey);
      }
    } else {
      if (Math.random() < this.epsilon) {
        this.lastAction =
          this.actions[Math.floor(Math.random() * this.actions.length)];
      } else {
        this.lastAction = this.actions.reduce(
          (best, a) => (this.q[a].value > this.q[best].value ? a : best),
          this.actions[0]
        );
      }
    }
    this.lastSlippage = Math.max(5, baseBips + this.lastAction);

    // epsilon decay after each action selection
    this.epsilon = Math.max(this.minEpsilon, this.epsilon * this.decay);

    return this.lastSlippage;
  }

  update(reward) {
    if (this.lastAction === null) return;
    const key = this.continuous
      ? String(Math.round(this.lastAction))
      : String(this.lastAction);
    if (!this.q[key]) this.q[key] = { value: 0, count: 0 };
    const entry = this.q[key];
    entry.count += 1;
    entry.value = entry.value + this.alpha * (reward - entry.value);
    this.queueSave();
  }
  resetPolicy({ persist = true } = {}) {
    this.q = {};
    if (!this.continuous) {
      this.actions = [...this.discreteActions];
      this.actions.forEach((a) => {
        this.q[a] = { value: 0, count: 0 };
      });
    }
    this.lastAction = null;
    this.lastSlippage = null;
    this.epsilon = this.initialEpsilon;
    if (persist) {
      this.queueSave();
    }
  }
}

let instance = null;

function initSlippageAgent(options = {}) {
  instance = new SlippageAgent(options);
  return instance;
}

function getSlippageAgent() {
  if (!instance) {
    throw new Error("SlippageAgent has not been initialised");
  }
  return instance;
}

module.exports = {
  SlippageAgent,
  initSlippageAgent,
  getSlippageAgent,
};
