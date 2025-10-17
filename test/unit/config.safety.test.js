const { expect } = require("chai");
const path = require("path");

const CONFIG_PATH = path.resolve(__dirname, "../../utils/config.js");

function importFresh() {
  delete require.cache[CONFIG_PATH];
  return require(CONFIG_PATH);
}

describe("utils/config security", () => {
  afterEach(() => {
    delete require.cache[CONFIG_PATH];
  });

  it("does not leak environment values during import", () => {
    const secret = "very-secret-value";
    process.env.TEST_SECRET_FOR_CONFIG = secret;

    const originalLog = console.log;
    const messages = [];
    console.log = (...args) => {
      messages.push(args.map(String).join(" "));
    };

    try {
      importFresh();
    } finally {
      console.log = originalLog;
      delete process.env.TEST_SECRET_FOR_CONFIG;
    }

    const output = messages.join(" ");
    expect(output).to.not.include(secret);
  });

  it("logs only missing variable names when loadRequired fails", () => {
    const { loadRequired } = importFresh();
    const missingKey = "CONFIG_TEST_MISSING";
    delete process.env[missingKey];

    const originalError = console.error;
    const errors = [];
    console.error = (...args) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      expect(() => loadRequired([missingKey])).to.throw(
        `Missing required env vars: ${missingKey}`
      );
    } finally {
      console.error = originalError;
    }

    const combinedErrors = errors.join(" ");
    expect(combinedErrors).to.include(missingKey);
    expect(combinedErrors).to.not.match(/undefined|null/);
  });
});
