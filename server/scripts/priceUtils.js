const CoinGecko = require("coingecko-api");
const coingecko = new CoinGecko();

/**
 * Fetch ETH/DAI price by pulling ETH–USD and DAI–USD, then dividing.
 * Retries up to 3 times on 429 errors with exponential backoff.
 *
 * @returns {Promise<number>} ethDaiPrice
 */
async function fetchEthDaiPrice() {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      // parallel fetch
      const [ethRes, daiRes] = await Promise.all([
        coingecko.simple.price({ ids: "ethereum", vs_currencies: "usd" }),
        coingecko.simple.price({ ids: "dai", vs_currencies: "usd" }),
      ]);

      const ethUsd = ethRes.data?.ethereum?.usd;
      const daiUsd = daiRes.data?.dai?.usd;

      if (typeof ethUsd !== "number" || typeof daiUsd !== "number") {
        throw new Error("Malformed Coingecko response");
      }

      return ethUsd / daiUsd;
    } catch (err) {
      attempt++;
      const isRateLimit = err?.response?.status === 429;
      if (attempt >= maxRetries || !isRateLimit) {
        console.warn(
          `[priceUtils] Failed to fetch ETH/DAI after ${attempt} attempt(s):`,
          err.message || err
        );
        // fallback to a safe hardcoded proxy if you really must
        return 2000;
      }
      // simple exponential backoff
      const delay = 500 * 2 ** (attempt - 1);
      console.warn(
        `[priceUtils] 429 from Coingecko, retrying in ${delay}ms (attempt ${
          attempt + 1
        })`
      );
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

module.exports = { fetchEthDaiPrice };
