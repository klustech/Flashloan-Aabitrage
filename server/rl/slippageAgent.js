const fs = require("fs");
const path = require("path");

class SlippageAgent {
  constructor() {
    this.file = path.resolve(__dirname, "slippage_data.json");
    this.actions = [-20, 0, 20, 40];
    this.epsilon = parseFloat(process.env.RL_EPSILON || "0.1");
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
    this.actions.forEach((a) => {
      if (!this.q[a]) this.q[a] = { value: 0, count: 0 };
    });
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.q, null, 2));
  }

  select(baseBips) {
    if (Math.random() < this.epsilon) {
      this.lastAction =
        this.actions[Math.floor(Math.random() * this.actions.length)];
    } else {
      this.lastAction = this.actions.reduce(
        (best, a) => (this.q[a].value > this.q[best].value ? a : best),
        this.actions[0]
      );
    }
    this.lastSlippage = Math.max(5, baseBips + this.lastAction);
    return this.lastSlippage;
  }

  update(reward) {
    if (this.lastAction === null) return;
    const entry = this.q[this.lastAction];
    entry.count += 1;
    entry.value = entry.value + this.alpha * (reward - entry.value);
    this.save();
  }
}

module.exports = new SlippageAgent();
