// Thin entry point; see backrun-economic-gates.js.
const { main } = require("./backrun-economic-gates");
main(["gas"]).then(s => { process.exitCode = Object.values(s).every(g => g.passed) ? 0 : 1; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
