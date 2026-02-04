/**
 * server/scripts/mempoolMonitor.js
 *
 * Mempool monitoring for backrun opportunity detection.
 * Subscribes to pending transactions and identifies large swaps
 * that create arbitrage opportunities.
 */

const { ethers, BigNumber } = require("ethers");
const winston = require("winston");
const EventEmitter = require("events");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  // Minimum swap value in ETH to consider for backrun
  MIN_SWAP_VALUE_ETH: parseFloat(process.env.MIN_BACKRUN_VALUE_ETH || "1"),

  // Maximum pending transactions to track
  MAX_PENDING_TXS: parseInt(process.env.MAX_PENDING_TXS || "1000", 10),

  // Transaction expiry time (ms)
  TX_EXPIRY_MS: parseInt(process.env.TX_EXPIRY_MS || "60000", 10),

  // Enable/disable mempool monitoring
  ENABLED: process.env.MEMPOOL_MONITORING === "true",

  // Known router addresses
  ROUTERS: {
    UNISWAP_V2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D".toLowerCase(),
    UNISWAP_V3: "0xE592427A0AEce92De3Edee1F18E0157C05861564".toLowerCase(),
    UNISWAP_UNIVERSAL: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD".toLowerCase(),
    SUSHISWAP: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F".toLowerCase(),
    ONEINCH_V5: "0x1111111254EEB25477B68fb85Ed929f73A960582".toLowerCase(),
    PARASWAP: "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57".toLowerCase(),
  },
};

// Router function signatures
const SWAP_SIGNATURES = {
  // Uniswap V2 Router
  "0x38ed1739": { name: "swapExactTokensForTokens", hasPath: true },
  "0x8803dbee": { name: "swapTokensForExactTokens", hasPath: true },
  "0x7ff36ab5": { name: "swapExactETHForTokens", hasPath: true },
  "0xfb3bdb41": { name: "swapETHForExactTokens", hasPath: true },
  "0x18cbafe5": { name: "swapExactTokensForETH", hasPath: true },
  "0x4a25d94a": { name: "swapTokensForExactETH", hasPath: true },

  // Uniswap V3 Router
  "0xc04b8d59": { name: "exactInput", hasPath: false },
  "0xdb3e2198": { name: "exactOutput", hasPath: false },
  "0x414bf389": { name: "exactInputSingle", hasPath: false },
  "0x5023b4df": { name: "exactOutputSingle", hasPath: false },

  // Universal Router (V3)
  "0x3593564c": { name: "execute", hasPath: false },
};

// ─────────────────────────────────────────────────────────────────────────────
// Mempool Monitor Class
// ─────────────────────────────────────────────────────────────────────────────

class MempoolMonitor extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.pendingTxs = new Map();
    this.isRunning = false;
    this.subscription = null;
    this.cleanupInterval = null;

    // Stats
    this.stats = {
      totalSeen: 0,
      swapsDetected: 0,
      backrunOpportunities: 0,
      errors: 0,
      startTime: null,
    };
  }

  /**
   * Start monitoring the mempool
   */
  async start() {
    if (this.isRunning) {
      logger.warn("[MempoolMonitor] Already running");
      return;
    }

    if (!CONFIG.ENABLED) {
      logger.info("[MempoolMonitor] Mempool monitoring is disabled");
      return;
    }

    try {
      logger.info("[MempoolMonitor] Starting mempool monitoring...");

      // Subscribe to pending transactions
      this.subscription = this.provider.on("pending", async (txHash) => {
        await this._handlePendingTx(txHash);
      });

      // Start cleanup interval
      this.cleanupInterval = setInterval(() => {
        this._cleanupExpired();
      }, 10000);

      this.isRunning = true;
      this.stats.startTime = Date.now();
      logger.info("[MempoolMonitor] Mempool monitoring started");
    } catch (error) {
      logger.error(`[MempoolMonitor] Failed to start: ${error.message}`);
      throw error;
    }
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (!this.isRunning) return;

    if (this.subscription) {
      this.provider.off("pending", this.subscription);
      this.subscription = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.isRunning = false;
    logger.info("[MempoolMonitor] Mempool monitoring stopped");
  }

  /**
   * Handle a pending transaction
   */
  async _handlePendingTx(txHash) {
    try {
      this.stats.totalSeen++;

      // Rate limiting - skip if we have too many pending
      if (this.pendingTxs.size >= CONFIG.MAX_PENDING_TXS) {
        return;
      }

      // Get transaction details
      const tx = await this.provider.getTransaction(txHash);
      if (!tx || !tx.to) return;

      // Check if it's a swap on a known router
      const toAddress = tx.to.toLowerCase();
      const isRouter = Object.values(CONFIG.ROUTERS).includes(toAddress);

      if (!isRouter) return;

      // Parse the swap
      const swapInfo = this._parseSwap(tx);
      if (!swapInfo) return;

      this.stats.swapsDetected++;

      // Check if swap is large enough for backrun
      const valueEth = parseFloat(ethers.utils.formatEther(swapInfo.value || tx.value));
      if (valueEth < CONFIG.MIN_SWAP_VALUE_ETH) return;

      // Store pending transaction
      this.pendingTxs.set(txHash, {
        tx,
        swapInfo,
        timestamp: Date.now(),
        valueEth,
      });

      // Analyze for backrun opportunity
      const opportunity = await this._analyzeBackrunOpportunity(tx, swapInfo);

      if (opportunity) {
        this.stats.backrunOpportunities++;
        this.emit("backrun_opportunity", opportunity);
        logger.info(
          `[MempoolMonitor] Backrun opportunity: ${swapInfo.name} ` +
          `${valueEth.toFixed(4)} ETH, estimated profit: ${opportunity.estimatedProfitEth.toFixed(6)} ETH`
        );
      }
    } catch (error) {
      this.stats.errors++;
      // Silently ignore errors for individual transactions
    }
  }

  /**
   * Parse swap details from transaction data
   */
  _parseSwap(tx) {
    if (!tx.data || tx.data.length < 10) return null;

    const selector = tx.data.slice(0, 10).toLowerCase();
    const swapSig = SWAP_SIGNATURES[selector];

    if (!swapSig) return null;

    try {
      // Basic swap info
      const swapInfo = {
        name: swapSig.name,
        selector,
        router: tx.to.toLowerCase(),
        value: tx.value,
        gasPrice: tx.gasPrice || tx.maxFeePerGas,
        gasLimit: tx.gasLimit,
      };

      // Try to decode path for V2 swaps
      if (swapSig.hasPath) {
        const decoded = this._decodeV2SwapPath(tx.data);
        if (decoded) {
          swapInfo.path = decoded.path;
          swapInfo.amountIn = decoded.amountIn;
          swapInfo.amountOutMin = decoded.amountOutMin;
        }
      }

      return swapInfo;
    } catch (error) {
      return null;
    }
  }

  /**
   * Decode V2 swap path
   */
  _decodeV2SwapPath(data) {
    try {
      // Different decodings based on function
      const selector = data.slice(0, 10).toLowerCase();

      // swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
      if (selector === "0x38ed1739") {
        const iface = new ethers.utils.Interface([
          "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)",
        ]);
        const decoded = iface.decodeFunctionData("swapExactTokensForTokens", data);
        return {
          amountIn: decoded.amountIn,
          amountOutMin: decoded.amountOutMin,
          path: decoded.path,
        };
      }

      // swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)
      if (selector === "0x7ff36ab5") {
        const iface = new ethers.utils.Interface([
          "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable",
        ]);
        const decoded = iface.decodeFunctionData("swapExactETHForTokens", data);
        return {
          amountIn: null, // Value is in tx.value
          amountOutMin: decoded.amountOutMin,
          path: decoded.path,
        };
      }

      // swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
      if (selector === "0x18cbafe5") {
        const iface = new ethers.utils.Interface([
          "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)",
        ]);
        const decoded = iface.decodeFunctionData("swapExactTokensForETH", data);
        return {
          amountIn: decoded.amountIn,
          amountOutMin: decoded.amountOutMin,
          path: decoded.path,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Analyze if a swap creates a backrun opportunity
   */
  async _analyzeBackrunOpportunity(tx, swapInfo) {
    try {
      // Calculate expected price impact
      const valueEth = parseFloat(ethers.utils.formatEther(swapInfo.value || tx.value));

      // Simple heuristic: larger swaps have more impact
      // More sophisticated analysis would simulate the swap
      const estimatedImpactBps = Math.min(valueEth * 10, 500); // Cap at 5%

      // Estimate backrun profit (very rough)
      // Actual profit depends on pool liquidity and our position
      const estimatedProfitBps = estimatedImpactBps * 0.3; // Capture ~30% of impact
      const estimatedProfitEth = (valueEth * estimatedProfitBps) / 10000;

      // Minimum profit threshold
      const minProfitEth = 0.001; // 0.001 ETH
      if (estimatedProfitEth < minProfitEth) return null;

      return {
        type: "backrun",
        targetTx: tx.hash,
        targetSwap: swapInfo,
        estimatedImpactBps,
        estimatedProfitBps,
        estimatedProfitEth,
        targetGasPrice: tx.gasPrice || tx.maxFeePerGas,
        path: swapInfo.path,
        timestamp: Date.now(),
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Clean up expired pending transactions
   */
  _cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    for (const [hash, data] of this.pendingTxs.entries()) {
      if (now - data.timestamp > CONFIG.TX_EXPIRY_MS) {
        this.pendingTxs.delete(hash);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[MempoolMonitor] Cleaned up ${cleaned} expired transactions`);
    }
  }

  /**
   * Get monitoring stats
   */
  getStats() {
    const runtime = this.stats.startTime
      ? Math.floor((Date.now() - this.stats.startTime) / 1000)
      : 0;

    return {
      ...this.stats,
      isRunning: this.isRunning,
      pendingCount: this.pendingTxs.size,
      runtimeSeconds: runtime,
      swapsPerMinute: runtime > 0 ? ((this.stats.swapsDetected / runtime) * 60).toFixed(2) : 0,
    };
  }

  /**
   * Get pending transactions
   */
  getPendingTransactions() {
    return Array.from(this.pendingTxs.entries()).map(([hash, data]) => ({
      hash,
      ...data.swapInfo,
      valueEth: data.valueEth,
      age: Date.now() - data.timestamp,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backrun Execution Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a backrun bundle
 * @param {Object} targetTx - The target transaction to backrun
 * @param {Object} backrunTx - Our backrun transaction
 * @param {number} targetBlock - Block to target
 */
function createBackrunBundle(targetTx, backrunTx, targetBlock) {
  return {
    txs: [targetTx.raw, backrunTx.raw],
    blockNumber: ethers.utils.hexValue(targetBlock),
    revertingTxHashes: [targetTx.hash], // Allow target to revert
  };
}

/**
 * Calculate optimal backrun parameters
 */
function calculateBackrunParams(opportunity, currentReserves, borrowAmount) {
  const {
    estimatedImpactBps,
    path,
  } = opportunity;

  // Calculate expected post-swap reserves
  // This is simplified - real implementation would simulate the swap

  // Our swap should be in the opposite direction
  const reversePath = [...path].reverse();

  // Size our swap based on the impact
  // Larger impact = larger opportunity but also more risk
  const swapSizeBps = Math.min(estimatedImpactBps * 2, 1000); // Cap at 10%
  const swapAmount = borrowAmount.mul(swapSizeBps).div(10000);

  return {
    path: reversePath,
    amountIn: swapAmount,
    // Set minimum output with slippage protection
    minAmountOutBps: 9900, // 1% slippage max
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

let monitorInstance = null;

/**
 * Get or create the mempool monitor instance
 */
function getMempoolMonitor(provider) {
  if (!monitorInstance && provider) {
    monitorInstance = new MempoolMonitor(provider);
  }
  return monitorInstance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Monitor class
  MempoolMonitor,

  // Singleton access
  getMempoolMonitor,

  // Backrun helpers
  createBackrunBundle,
  calculateBackrunParams,

  // Config
  CONFIG,
  SWAP_SIGNATURES,
};
