const { expect } = require("chai");

describe("slippageAgent", function () {
  beforeEach(() => {
    delete require.cache[require.resolve("../../server/rl/slippageAgent")];
    process.env.RL_EPSILON_START = "0.2";
    process.env.RL_EPSILON_MIN = "0.05";
    process.env.RL_EPSILON_DECAY = "0.5";
  });

  it("decays epsilon after each action", function () {
    const agent = require("../../server/rl/slippageAgent");
    const initial = agent.epsilon;
    agent.select(50);
    expect(agent.epsilon).to.be.below(initial);
  });

  it("exposes additional actions", function () {
    const agent = require("../../server/rl/slippageAgent");
    if (agent.continuous) {
      expect(agent.actions.length).to.equal(0);
    } else {
      expect(agent.actions).to.include.members([-10, 10]);
    }
  });
});
