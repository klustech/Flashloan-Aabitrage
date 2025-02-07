// scripts/monitorPairs.js

const { ethers } = require('ethers');
const { getSettings } = require('./settings');
const { logMessage } = require('./logging');

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

/**
 * Monitors an existing pair for liquidity changes.
 * Calls the callback when base token liquidity exceeds the threshold.
 *
 * @param {string} pairAddress
 * @param {function} callback - Called as callback(isViable, baseReserve)
 */
async function monitorPairLiquidity(pairAddress, callback) {
  const settings = getSettings();
  const provider = new ethers.providers.WebSocketProvider(settings.RPC_URL_WSS);
  const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const baseTokenAddress = settings.BASE_TOKEN_ADDRESS.toLowerCase();
  const minBaseReserve = settings.MIN_BASE_TOKEN_RESERVE;
  
  setInterval(async () => {
    try {
      const token0 = await pairContract.token0();
      const reserves = await pairContract.getReserves();
      let baseReserve;
      if (token0.toLowerCase() === baseTokenAddress) {
        baseReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve0, 18));
      } else {
        baseReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve1, 18));
      }
      logMessage(`Monitoring liquidity for pair ${pairAddress}: baseReserve = ${baseReserve}`, {}, 'info');
      callback(baseReserve >= minBaseReserve, baseReserve);
    } catch (err) {
      logMessage(`Error monitoring liquidity for pair ${pairAddress}: ${err.message}`, {}, 'error');
    }
  }, 30000); // Check every 30 seconds
}

module.exports = { monitorPairLiquidity };
