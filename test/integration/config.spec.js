const { expect } = require("chai");
const { loadRequired } = require("../../utils/config");

describe("config loader", function () {
  it("loads required environment variables", function () {
    process.env.TEST_REQ = "hello";
    const out = loadRequired(["TEST_REQ"]);
    expect(out.TEST_REQ).to.equal("hello");
  });
});
