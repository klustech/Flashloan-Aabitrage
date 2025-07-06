const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: true,
});
const axios = require("axios");
const { CHAIN_CONFIGS } = require("../server/scripts/liquidityScanner");

const query = '{ __type(name:"Query") { fields { name } } }';

async function check(url, name) {
  try {
    const resp = await axios.post(
      url,
      { query },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    if (resp.data && !resp.data.errors) {
      const fieldCount =
        resp.data.data && resp.data.data.__type && resp.data.data.__type.fields
          ? resp.data.data.__type.fields.length
          : 0;
      console.log(`[OK] ${name} (${fieldCount} fields)`);
    } else {
      console.error(`[FAIL] ${name}:`, JSON.stringify(resp.data.errors));
    }
  } catch (err) {
    console.error(`[ERROR] ${name}: ${err.message}`);
  }
}

(async () => {
  for (const [chain, cfg] of Object.entries(CHAIN_CONFIGS)) {
    for (const [dex, sub] of Object.entries(cfg)) {
      if (sub && sub.subgraphUrl) {
        await check(sub.subgraphUrl, `${chain}:${dex}`);
      }
    }
  }
})();
