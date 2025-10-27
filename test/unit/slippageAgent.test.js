const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("slippageAgent", function () {
  let tmpFile;

  beforeEach(() => {
    delete require.cache[require.resolve("../../server/rl/slippageAgent")];
    tmpFile = path.join(
      os.tmpdir(),
      `slippage_agent_${Date.now()}_${Math.random().toString(16).slice(2)}.json`,
    );
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  function createAgent(overrides = {}) {
    const { initSlippageAgent } = require("../../server/rl/slippageAgent");
    return initSlippageAgent({
      storagePath: tmpFile,
      continuous: false,
      epsilonStart: 0.2,
      epsilonMin: 0.05,
      epsilonDecay: 0.5,
      ...overrides,
    });
  }

  it("decays epsilon after each action", function () {
    const agent = createAgent();
    const initial = agent.epsilon;
    agent.select(50);
    expect(agent.epsilon).to.be.below(initial);
  });

  it("exposes additional actions", function () {
    const agent = createAgent();
    if (agent.continuous) {
      expect(agent.actions.length).to.equal(0);
    } else {
      expect(agent.actions).to.include.members([-10, 10]);
    }
  });
});
