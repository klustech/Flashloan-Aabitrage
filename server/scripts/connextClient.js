/**
 * server/scripts/connextClient.js
 *
 * Connext Cross-Chain Integration for Flash Loan Arbitrage Bot
 * Enables profit forwarding across chains via Connext bridge
 */

const { ethers } = require("ethers");

// ConnextAdapter ABI (from deployed contract)
const CONNEXT_ADAPTER_ABI = [
  "function forwardProfits(address token, uint256 amount, uint256 relayerFee) external payable",
  "function connext() external view returns (address)",
  "function destinationDomain() external view returns (uint32)",
  "function recipientOnDestination() external view returns (address)",
  "function owner() external view returns (address)",
  "function setDestination(uint32 _domain, address _recipient) external",
  "event ProfitsForwarded(address indexed token, uint256 amount, uint32 destinationDomain, address recipient, bytes32 transferId)",
];

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
  minForwardAmount: ethers.utils.parseUnits("10", 18), // 10 tokens

  // Relayer fee buffer (10% over estimated)
  relayerFeeBuffer: 1.1,

  // Maximum relayer fee (prevent excessive fees)
  maxRelayerFee: ethers.utils.parseUnits("0.1", 18), // 0.1 ETH

  // Auto-forward on profit threshold
  autoForwardEnabled: false,
  autoForwardThreshold: ethers.utils.parseUnits("100", 18), // 100 tokens
};

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
    recipient: await connextAdapter.recipientOnDestination(),
  };
}

/**
 * Estimate relayer fee for cross-chain transfer
 * @param {string} token - Token address
 * @param {BigNumber} amount - Amount to transfer
 * @returns {BigNumber} - Estimated relayer fee in native token
 */
async function estimateRelayerFee(token, amount) {
  // In production, query Connext API for accurate fee estimation
  // For now, use a simple heuristic based on amount
  const baseFeeBps = 30; // 0.3% base fee
  const baseFee = amount.mul(baseFeeBps).div(10000);

  // Add gas cost estimation (approximately 200k gas for xcall)
  const gasPrice = await provider.getGasPrice();
  const gasCost = gasPrice.mul(200000);

  const totalFee = baseFee.add(gasCost);

  // Apply buffer
  const bufferedFee = totalFee.mul(Math.floor(config.relayerFeeBuffer * 100)).div(100);

  // Cap at max
  return bufferedFee.gt(config.maxRelayerFee) ? config.maxRelayerFee : bufferedFee;
}

/**
 * Forward profits to destination chain
 * @param {Object} params - Forward parameters
 * @returns {Object} - Transaction result
 */
async function forwardProfits(params) {
  const { token, amount, relayerFee: customRelayerFee } = params;

  if (!connextAdapter) {
    throw new Error("Connext client not initialized. Call initConnextClient first.");
  }

  if (!signer) {
    throw new Error("Signer required for forwarding profits");
  }

  // Validate amount
  const amountBN = ethers.BigNumber.from(amount);
  if (amountBN.lt(config.minForwardAmount)) {
    return {
      success: false,
      reason: `Amount ${ethers.utils.formatUnits(amountBN, 18)} below minimum ${ethers.utils.formatUnits(config.minForwardAmount, 18)}`,
    };
  }

  // Estimate or use custom relayer fee
  const relayerFee = customRelayerFee
    ? ethers.BigNumber.from(customRelayerFee)
    : await estimateRelayerFee(token, amountBN);

  console.log(`[connextClient] Forwarding ${ethers.utils.formatUnits(amountBN, 18)} tokens`);
  console.log(`[connextClient] Relayer fee: ${ethers.utils.formatUnits(relayerFee, 18)} ETH`);

  try {
    // Approve token if needed
    const tokenContract = new ethers.Contract(
      token,
      ["function approve(address,uint256)", "function allowance(address,address) view returns (uint256)"],
      signer
    );

    const currentAllowance = await tokenContract.allowance(
      await signer.getAddress(),
      connextAdapter.address
    );

    if (currentAllowance.lt(amountBN)) {
      console.log("[connextClient] Approving token for adapter...");
      const approveTx = await tokenContract.approve(connextAdapter.address, amountBN);
      await approveTx.wait();
    }

    // Forward profits
    const tx = await connextAdapter.forwardProfits(token, amountBN, relayerFee, {
      value: relayerFee,
      gasLimit: 500000,
    });

    console.log(`[connextClient] Transaction sent: ${tx.hash}`);
    const receipt = await tx.wait();

    // Parse event for transfer ID
    const event = receipt.events?.find(e => e.event === "ProfitsForwarded");
    const transferId = event?.args?.transferId;

    // Track the transfer
    if (transferId) {
      trackTransfer({
        transferId,
        txHash: tx.hash,
        token,
        amount: amountBN,
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
    relayerFee,
    timestamp = Date.now(),
  } = transferData;

  const transfer = {
    transferId,
    txHash,
    token,
    amount: amount.toString(),
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
    if (status === TransferStatus.COMPLETED || status === TransferStatus.FAILED) {
      pendingTransfers.delete(transferId);
    }

    // Update in history
    const historyEntry = transferHistory.find(t => t.transferId === transferId);
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
    const tracked = pendingTransfers.get(transferId) ||
      transferHistory.find(t => t.transferId === transferId);

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
 * @returns {BigNumber} - Balance in adapter
 */
async function getAccumulatedProfits(token) {
  if (!connextAdapter) {
    throw new Error("Connext client not initialized");
  }

  const tokenContract = new ethers.Contract(
    token,
    ["function balanceOf(address) view returns (uint256)"],
    provider
  );

  return await tokenContract.balanceOf(connextAdapter.address);
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
  const recipient = await connextAdapter.recipientOnDestination();

  // Reverse lookup domain name
  const domainName = Object.entries(CONNEXT_DOMAINS).find(
    ([, id]) => id === domain
  )?.[0] || "unknown";

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
async function updateDestination(domain, recipient) {
  if (!connextAdapter || !signer) {
    throw new Error("Connext client not initialized with signer");
  }

  const tx = await connextAdapter.setDestination(domain, recipient);
  await tx.wait();

  console.log(`[connextClient] Destination updated to domain ${domain}, recipient ${recipient}`);
  return tx.hash;
}

/**
 * Get domain ID by chain name
 * @param {string} chainName - Chain name
 * @returns {number} - Connext domain ID
 */
function getDomainId(chainName) {
  const domain = CONNEXT_DOMAINS[chainName.toLowerCase()];
  if (!domain) {
    throw new Error(`Unknown chain: ${chainName}. Available: ${Object.keys(CONNEXT_DOMAINS).join(", ")}`);
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

  if (balance.gte(config.autoForwardThreshold)) {
    return {
      shouldForward: true,
      balance,
      threshold: config.autoForwardThreshold,
    };
  }

  return {
    shouldForward: false,
    balance,
    threshold: config.autoForwardThreshold,
    reason: "Below threshold",
  };
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
  // Transfer tracking
  trackTransfer,
  updateTransferStatus,
  getTransferHistory,
  getPendingTransfers,
  TransferStatus,
  // Constants
  CONNEXT_DOMAINS,
  CONNEXT_ADAPTER_ABI,
  DEFAULT_CONFIG,
};
