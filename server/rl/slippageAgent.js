const fs = require("fs");
const path = require("path");

class SlippageAgent {
  constructor() {
    this.file = path.resolve(__dirname, "slippage_data.json");
    this.continuous = process.env.RL_CONTINUOUS === "true";
    this.maxOffset = parseFloat(process.env.RL_MAX_OFFSET_BIPS || "40");
    this.actions = this.continuous ? [] : [-20, -10, 0, 10, 20, 40];
    this.epsilon = parseFloat(process.env.RL_EPSILON_START || "0.2");
    this.minEpsilon = parseFloat(process.env.RL_EPSILON_MIN || "0.05");
    this.decay = parseFloat(process.env.RL_EPSILON_DECAY || "0.995");
    this.alpha = parseFloat(process.env.RL_ALPHA || "0.2");
    this.q = {};
    this.lastAction = null;
    this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      try {
        this.q = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        this.q = {};
      }
    }
    if (!this.continuous) {
      this.actions.forEach((a) => {
        if (!this.q[a]) this.q[a] = { value: 0, count: 0 };
      });
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.q, null, 2));
  }

  select(baseBips) {
    if (this.continuous) {
      if (Math.random() < this.epsilon || !Object.keys(this.q).length) {
        this.lastAction =
          (Math.random() * 2 - 1) * this.maxOffset;
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
    this.save();
  }
}

module.exports = new SlippageAgent();
