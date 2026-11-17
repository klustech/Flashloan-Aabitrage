/**
 * server/scripts/connextClient.js
 *
 * Connext Cross-Chain Integration for Flash Loan Arbitrage Bot
 * Enables profit forwarding across chains via Connext bridge
 */

const { ethers } = require("ethers");
const axios = require("axios");

// Import event bus for alerts
let eventBus;
try {
  eventBus = require("../utils/eventBus");
} catch (e) {
  eventBus = null;
}

// Import Slack utils for alerts
let sendSlackAlert;
try {
  ({ sendSlackAlert } = require("./slackUtils"));
} catch (e) {
  sendSlackAlert = async (msg) => console.log(`[Connext Alert] ${msg}`);
}

// ConnextAdapter ABI (contracts/ConnextAdapter.sol). The destination is
// immutable; forwardArbitrage pulls `amount` from the owner (the signer here)
// and requires msg.value == relayerFee.
const CONNEXT_ADAPTER_ABI = [
  "function forwardArbitrage(address token, uint256 amount, uint256 relayerFee) external payable returns (bytes32)",
  "function connext() external view returns (address)",
  "function destinationDomain() external view returns (uint32)",
  "function destinationContract() external view returns (address)",
  "function owner() external view returns (address)",
  "event ArbitrageForwarded(address indexed token, uint256 amount, address indexed recipient, bytes32 transferId)",
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const decimalsCache = new Map();

/** Token decimals, read once per token. Amount thresholds are configured in whole tokens. */
async function tokenDecimals(token) {
  const key = token.toLowerCase();
  if (!decimalsCache.has(key)) {
    const decimals = await new ethers.Contract(
      token,
      ERC20_ABI,
      provider
    ).decimals();
    decimalsCache.set(key, Number(decimals));
  }
  return decimalsCache.get(key);
}

/** Parse a whole-token threshold (string or number) into `token`'s base units. */
async function tokenAmount(token, wholeTokens) {
  return ethers.utils.parseUnits(
    String(wholeTokens),
    await tokenDecimals(token)
  );
}

// Connext domain IDs
const CONNEXT_DOMAINS = {
  ethereum: 6648936,
  optimism: 1869640809,
  arbitrum: 1634886255,
  polygon: 1886350457,
  gnosis: 6778479,
  bnb: 6450786,
};

// Default configuration
const DEFAULT_CONFIG = {
  // Minimum profit to trigger cross-chain forwarding
  minForwardAmount: "10", // whole tokens, scaled by the token's decimals

  // Relayer fee buffer (10% over estimated)
  relayerFeeBuffer: 1.1,

  // Maximum relayer fee (prevent excessive fees)
  maxRelayerFee: ethers.utils.parseUnits("0.1", 18), // 0.1 ETH

  // Auto-forward on profit threshold
  autoForwardEnabled: false,
  autoForwardThreshold: "100", // whole tokens, scaled by the token's decimals

  // Monitoring configuration
  monitoringEnabled: true,
  monitoringIntervalMs: 60000, // Check every minute
  stuckTransferThresholdMs: 30 * 60 * 1000, // 30 minutes
  alertOnCompletion: true,
  alertOnFailure: true,
  alertOnStuck: true,
};

// Connext subgraph endpoints by network
const CONNEXT_SUBGRAPH_URLS = {
  ethereum:
    "https://api.thegraph.com/subgraphs/name/connext/amarok-runtime-v0-mainnet",
  optimism:
    "https://api.thegraph.com/subgraphs/name/connext/amarok-runtime-v0-optimism",
  arbitrum:
    "https://api.thegraph.com/subgraphs/name/connext/amarok-runtime-v0-arbitrum-one",
  polygon:
    "https://api.thegraph.com/subgraphs/name/connext/amarok-runtime-v0-polygon",
};

// Monitoring state
let monitoringInterval = null;
let sourceChain = "ethereum";

// State
let connextAdapter = null;
let provider = null;
let signer = null;
let config = { ...DEFAULT_CONFIG };

// Pending transfers tracking
const pendingTransfers = new Map();
const transferHistory = [];
const MAX_HISTORY_SIZE = 100;

// Transfer status enum
const TransferStatus = {
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  UNKNOWN: "unknown",
};

/**
 * Initialize the Connext client
 * @param {Object} params - Initialization parameters
 */
async function initConnextClient(params) {
  const {
    adapterAddress,
    provider: _provider,
    signer: _signer,
    config: _config,
  } = params;

  if (!adapterAddress) {
    throw new Error("ConnextAdapter address is required");
  }

  provider = _provider;
  signer = _signer;
  config = { ...DEFAULT_CONFIG, ..._config };

  connextAdapter = new ethers.Contract(
    adapterAddress,
    CONNEXT_ADAPTER_ABI,
    signer || provider
  );

  // Verify contract is deployed
  const code = await provider.getCode(adapterAddress);
  if (code === "0x") {
    throw new Error(`No contract deployed at ${adapterAddress}`);
  }

  console.log(`[connextClient] Initialized with adapter at ${adapterAddress}`);

  return {
    adapter: connextAdapter,
    destinationDomain: await connextAdapter.destinationDomain(),
    recipient: await connextAdapter.destinationContract(),
  };
}

/**
 * Estimate relayer fee for cross-chain transfer
 * @param {string} token - Token address
 * @param {BigNumber} amount - Amount to transfer
 * @returns {BigNumber} - Estimated relayer fee in native token
 */
async function estimateRelayerFee(_token, _amount) {
  // The relayer fee is paid in native currency (msg.value), so it is estimated
  // from gas alone, never from the token amount (which is in token units).
  // Heuristic: ~200k gas for destination execution at the current gas price.
  // In production, query Connext's fee endpoint instead.
  const gasPrice = await provider.getGasPrice();
  const totalFee = gasPrice.mul(200000);

  // Apply buffer
  const bufferedFee = totalFee
    .mul(Math.floor(config.relayerFeeBuffer * 100))
    .div(100);

  // Cap at max
  return bufferedFee.gt(config.maxRelayerFee)
    ? config.maxRelayerFee
    : bufferedFee;
}

/**
 * Forward profits to destination chain
 * @param {Object} params - Forward parameters
 * @returns {Object} - Transaction result
 */
async function forwardProfits(params) {
  const { token, amount, relayerFee: customRelayerFee } = params;

  if (!connextAdapter) {
    throw new Error(
      "Connext client not initialized. Call initConnextClient first."
    );
  }

  if (!signer) {
    throw new Error("Signer required for forwarding profits");
  }

  // Validate amount in the token's own units
  const decimals = await tokenDecimals(token);
  const amountBN = ethers.BigNumber.from(amount);
  const minimum = await tokenAmount(token, config.minForwardAmount);
  if (amountBN.lt(minimum)) {
    return {
      success: false,
      reason: `Amount ${ethers.utils.formatUnits(
        amountBN,
        decimals
      )} below minimum ${ethers.utils.formatUnits(minimum, decimals)}`,
    };
  }

  // Estimate or use custom relayer fee
  const relayerFee = customRelayerFee
    ? ethers.BigNumber.from(customRelayerFee)
    : await estimateRelayerFee(token, amountBN);

  console.log(
    `[connextClient] Forwarding ${ethers.utils.formatUnits(
      amountBN,
      decimals
    )} tokens`
  );
  console.log(
    `[connextClient] Relayer fee: ${ethers.utils.formatUnits(
      relayerFee,
      18
    )} ETH`
  );

  try {
    // Approve token if needed
    const tokenContract = new ethers.Contract(token, ERC20_ABI, signer);

    const currentAllowance = await tokenContract.allowance(
      await signer.getAddress(),
      connextAdapter.address
    );

    if (currentAllowance.lt(amountBN)) {
      console.log("[connextClient] Approving token for adapter...");
      const approveTx = await tokenContract.approve(
        connextAdapter.address,
        amountBN
      );
      await approveTx.wait();
    }

    // Forward profits
    const tx = await connextAdapter.forwardArbitrage(
      token,
      amountBN,
      relayerFee,
      {
        value: relayerFee,
        gasLimit: 500000,
      }
    );

    console.log(`[connextClient] Transaction sent: ${tx.hash}`);
    const receipt = await tx.wait();

    // Parse event for transfer ID
    const event = receipt.events?.find((e) => e.event === "ArbitrageForwarded");
    const transferId = event?.args?.transferId;

    // Track the transfer
    if (transferId) {
      trackTransfer({
        transferId,
        txHash: tx.hash,
        token,
        amount: amountBN,
        decimals,
        relayerFee,
      });
    }

    return {
      success: true,
      txHash: tx.hash,
      transferId,
      amount: amountBN.toString(),
      relayerFee: relayerFee.toString(),
      blockNumber: receipt.blockNumber,
      tracked: !!transferId,
    };
  } catch (err) {
    console.error(`[connextClient] Forward failed: ${err.message}`);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Track a new transfer
 * @param {Object} transferData - Transfer data
 */
function trackTransfer(transferData) {
  const {
    transferId,
    txHash,
    token,
    amount,
    decimals = 18,
    relayerFee,
    timestamp = Date.now(),
  } = transferData;

  const transfer = {
    transferId,
    txHash,
    token,
    amount: amount.toString(),
    decimals,
    relayerFee: relayerFee.toString(),
    status: TransferStatus.PENDING,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  pendingTransfers.set(transferId, transfer);

  // Add to history
  transferHistory.unshift(transfer);
  if (transferHistory.length > MAX_HISTORY_SIZE) {
    transferHistory.pop();
  }

  return transfer;
}

/**
 * Update transfer status
 * @param {string} transferId - Transfer ID
 * @param {string} status - New status
 * @param {Object} extraData - Additional data to merge
 */
function updateTransferStatus(transferId, status, extraData = {}) {
  const transfer = pendingTransfers.get(transferId);
  if (transfer) {
    transfer.status = status;
    transfer.updatedAt = Date.now();
    Object.assign(transfer, extraData);

    // Remove from pending if completed or failed
    if (
      status === TransferStatus.COMPLETED ||
      status === TransferStatus.FAILED
    ) {
      pendingTransfers.delete(transferId);
    }

    // Update in history
    const historyEntry = transferHistory.find(
      (t) => t.transferId === transferId
    );
    if (historyEntry) {
      Object.assign(historyEntry, transfer);
    }
  }
  return transfer;
}

/**
 * Check pending cross-chain transfers
 * @param {string} transferId - Connext transfer ID (optional)
 * @returns {Object} - Transfer status
 */
async function checkTransferStatus(transferId) {
  // If specific transfer ID provided, check that one
  if (transferId) {
    const tracked =
      pendingTransfers.get(transferId) ||
      transferHistory.find((t) => t.transferId === transferId);

    if (tracked) {
      // TODO: In production, also query Connext API for real-time status
      return {
        ...tracked,
        apiStatus: "Query Connext subgraph for real-time updates",
      };
    }

    return {
      transferId,
      status: TransferStatus.UNKNOWN,
      message: "Transfer not found in local tracking",
    };
  }

  // Return all pending transfers
  return {
    pending: Array.from(pendingTransfers.values()),
    count: pendingTransfers.size,
  };
}

/**
 * Get transfer history
 * @param {number} limit - Max entries to return
 * @returns {Array} - Transfer history
 */
function getTransferHistory(limit = 20) {
  return transferHistory.slice(0, limit);
}

/**
 * Get all pending transfers
 * @returns {Array} - Pending transfers
 */
function getPendingTransfers() {
  return Array.from(pendingTransfers.values());
}

/**
 * Get accumulated profits ready for forwarding
 * @param {string} token - Token address
 * @returns {BigNumber} - Balance held by the adapter owner (the signer). The
 *   adapter pulls forwarded tokens from its owner, so that is where profits
 *   must sit to be forwarded.
 */
async function getAccumulatedProfits(token) {
  if (!connextAdapter || !signer) {
    throw new Error("Connext client not initialized with signer");
  }

  const tokenContract = new ethers.Contract(token, ERC20_ABI, provider);
  return await tokenContract.balanceOf(await signer.getAddress());
}

/**
 * Get destination configuration
 * @returns {Object} - Destination info
 */
async function getDestinationInfo() {
  if (!connextAdapter) {
    throw new Error("Connext client not initialized");
  }

  const domain = await connextAdapter.destinationDomain();
  const recipient = await connextAdapter.destinationContract();

  // Reverse lookup domain name
  const domainName =
    Object.entries(CONNEXT_DOMAINS).find(([, id]) => id === domain)?.[0] ||
    "unknown";

  return {
    domain,
    domainName,
    recipient,
  };
}

/**
 * Update destination (owner only)
 * @param {number} domain - New destination domain
 * @param {string} recipient - New recipient address
 */
async function updateDestination(_domain, _recipient) {
  // destinationDomain and destinationContract are immutable on ConnextAdapter.
  throw new Error(
    "ConnextAdapter destination is immutable; deploy a new adapter to change it"
  );
}

/**
 * Get domain ID by chain name
 * @param {string} chainName - Chain name
 * @returns {number} - Connext domain ID
 */
function getDomainId(chainName) {
  const domain = CONNEXT_DOMAINS[chainName.toLowerCase()];
  if (!domain) {
    throw new Error(
      `Unknown chain: ${chainName}. Available: ${Object.keys(
        CONNEXT_DOMAINS
      ).join(", ")}`
    );
  }
  return domain;
}

/**
 * Check if auto-forward should be triggered
 * @param {string} token - Token address
 * @returns {Object} - { shouldForward, balance }
 */
async function checkAutoForward(token) {
  if (!config.autoForwardEnabled) {
    return { shouldForward: false, reason: "Auto-forward disabled" };
  }

  const balance = await getAccumulatedProfits(token);
  const threshold = await tokenAmount(token, config.autoForwardThreshold);
  const decimals = await tokenDecimals(token);

  if (balance.gte(threshold)) {
    return { shouldForward: true, balance, threshold, decimals };
  }

  return {
    shouldForward: false,
    balance,
    threshold,
    decimals,
    reason: "Below threshold",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Automated Monitoring & Alerts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query Connext subgraph for transfer status
 * @param {string} transferId - Transfer ID to check
 * @returns {Object} - Transfer status from subgraph
 */
async function queryConnextSubgraph(transferId) {
  const subgraphUrl = CONNEXT_SUBGRAPH_URLS[sourceChain];
  if (!subgraphUrl) {
    return { error: `No subgraph URL for chain: ${sourceChain}` };
  }

  const query = `
    query GetTransfer($transferId: ID!) {
      originTransfer(id: $transferId) {
        transferId
        status
        originDomain
        destinationDomain
        asset
        amount
        bridgedAmount
        timestamp
        txHash
      }
      destinationTransfer(id: $transferId) {
        transferId
        status
        executedTxHash
        reconciledTxHash
        timestamp
      }
    }
  `;

  try {
    const response = await axios.post(
      subgraphUrl,
      { query, variables: { transferId } },
      { timeout: 10000 }
    );

    const { originTransfer, destinationTransfer } = response.data?.data || {};

    return {
      origin: originTransfer,
      destination: destinationTransfer,
      status:
        destinationTransfer?.status || originTransfer?.status || "unknown",
      completed:
        destinationTransfer?.status === "Executed" ||
        destinationTransfer?.status === "Reconciled",
    };
  } catch (err) {
    console.warn(`[Connext] Subgraph query failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Check all pending transfers and update their status
 */
async function checkPendingTransfersStatus() {
  const pending = getPendingTransfers();
  if (pending.length === 0) return;

  console.log(
    `[Connext Monitor] Checking ${pending.length} pending transfers...`
  );

  for (const transfer of pending) {
    try {
      const subgraphStatus = await queryConnextSubgraph(transfer.transferId);
      const now = Date.now();
      const age = now - transfer.createdAt;

      // Check if completed
      if (subgraphStatus.completed) {
        updateTransferStatus(transfer.transferId, TransferStatus.COMPLETED, {
          completedAt: now,
          destinationTxHash: subgraphStatus.destination?.executedTxHash,
        });

        // Send completion alert
        if (config.alertOnCompletion) {
          const amount = ethers.utils.formatUnits(
            transfer.amount,
            transfer.decimals ?? 18
          );
          await sendSlackAlert(
            `✅ [Connext] Cross-chain transfer completed!\n` +
              `Transfer ID: ${transfer.transferId}\n` +
              `Amount: ${amount} tokens\n` +
              `Duration: ${Math.round(age / 60000)} minutes`
          );
        }

        // Emit event
        if (eventBus) {
          eventBus.emitConnextTransfer({
            type: "completed",
            transfer: { ...transfer, status: TransferStatus.COMPLETED },
          });
        }
      }
      // Check if failed
      else if (
        subgraphStatus.status === "Failed" ||
        subgraphStatus.status === "Cancelled"
      ) {
        updateTransferStatus(transfer.transferId, TransferStatus.FAILED, {
          failedAt: now,
          failureReason: subgraphStatus.status,
        });

        // Send failure alert
        if (config.alertOnFailure) {
          const amount = ethers.utils.formatUnits(
            transfer.amount,
            transfer.decimals ?? 18
          );
          await sendSlackAlert(
            `❌ [Connext] Cross-chain transfer FAILED!\n` +
              `Transfer ID: ${transfer.transferId}\n` +
              `Amount: ${amount} tokens\n` +
              `Reason: ${subgraphStatus.status}\n` +
              `Original TX: ${transfer.txHash}`
          );
        }

        // Emit event
        if (eventBus) {
          eventBus.emitConnextTransfer({
            type: "failed",
            transfer: { ...transfer, status: TransferStatus.FAILED },
          });
        }
      }
      // Check if stuck
      else if (age > config.stuckTransferThresholdMs) {
        // Mark as potentially stuck (but don't change status yet)
        if (!transfer.stuckAlertSent) {
          transfer.stuckAlertSent = true;

          if (config.alertOnStuck) {
            const amount = ethers.utils.formatUnits(
              transfer.amount,
              transfer.decimals ?? 18
            );
            await sendSlackAlert(
              `⚠️ [Connext] Transfer may be stuck!\n` +
                `Transfer ID: ${transfer.transferId}\n` +
                `Amount: ${amount} tokens\n` +
                `Age: ${Math.round(age / 60000)} minutes\n` +
                `Status: ${subgraphStatus.status || "unknown"}\n` +
                `Please check Connextscan: https://connextscan.io/tx/${transfer.transferId}`
            );
          }

          // Emit event
          if (eventBus) {
            eventBus.emitConnextTransfer({
              type: "stuck",
              transfer,
              age,
            });
          }
        }
      }
    } catch (err) {
      console.error(
        `[Connext Monitor] Error checking transfer ${transfer.transferId}: ${err.message}`
      );
    }
  }
}

/**
 * Start automated monitoring of pending transfers
 */
function startMonitoring() {
  if (monitoringInterval) {
    console.log("[Connext Monitor] Already running");
    return;
  }

  if (!config.monitoringEnabled) {
    console.log("[Connext Monitor] Monitoring disabled in config");
    return;
  }

  console.log(
    `[Connext Monitor] Starting (interval: ${config.monitoringIntervalMs}ms)`
  );

  // Run immediately
  checkPendingTransfersStatus().catch((err) => {
    console.error(`[Connext Monitor] Initial check failed: ${err.message}`);
  });

  // Schedule periodic checks
  monitoringInterval = setInterval(() => {
    checkPendingTransfersStatus().catch((err) => {
      console.error(`[Connext Monitor] Check failed: ${err.message}`);
    });
  }, config.monitoringIntervalMs);
}

/**
 * Stop automated monitoring
 */
function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log("[Connext Monitor] Stopped");
  }
}

/**
 * Get monitoring status
 */
function getMonitoringStatus() {
  return {
    enabled: config.monitoringEnabled,
    running: !!monitoringInterval,
    intervalMs: config.monitoringIntervalMs,
    stuckThresholdMs: config.stuckTransferThresholdMs,
    pendingCount: pendingTransfers.size,
    alerts: {
      onCompletion: config.alertOnCompletion,
      onFailure: config.alertOnFailure,
      onStuck: config.alertOnStuck,
    },
  };
}

/**
 * Update monitoring configuration
 * @param {Object} newConfig - New monitoring settings
 */
function updateMonitoringConfig(newConfig) {
  const restartNeeded =
    newConfig.monitoringIntervalMs !== undefined &&
    newConfig.monitoringIntervalMs !== config.monitoringIntervalMs;

  Object.assign(config, newConfig);

  if (restartNeeded && monitoringInterval) {
    stopMonitoring();
    startMonitoring();
  }

  return getMonitoringStatus();
}

/**
 * Set the source chain for subgraph queries
 * @param {string} chain - Chain name
 */
function setSourceChain(chain) {
  if (CONNEXT_SUBGRAPH_URLS[chain]) {
    sourceChain = chain;
    console.log(`[Connext] Source chain set to: ${chain}`);
  } else {
    console.warn(`[Connext] Unknown chain: ${chain}, using ${sourceChain}`);
  }
}

module.exports = {
  initConnextClient,
  forwardProfits,
  estimateRelayerFee,
  checkTransferStatus,
  getAccumulatedProfits,
  getDestinationInfo,
  updateDestination,
  getDomainId,
  checkAutoForward,
  tokenDecimals,
  // Transfer tracking
  trackTransfer,
  updateTransferStatus,
  getTransferHistory,
  getPendingTransfers,
  TransferStatus,
  // Monitoring
  startMonitoring,
  stopMonitoring,
  getMonitoringStatus,
  updateMonitoringConfig,
  checkPendingTransfersStatus,
  queryConnextSubgraph,
  setSourceChain,
  // Constants
  CONNEXT_DOMAINS,
  CONNEXT_SUBGRAPH_URLS,
  CONNEXT_ADAPTER_ABI,
  DEFAULT_CONFIG,
};
