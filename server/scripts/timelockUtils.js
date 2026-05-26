/**
 * server/scripts/timelockUtils.js
 *
 * Timelock Administration Utilities for Flash Loan Arbitrage Bot
 * Handles scheduling and execution of governance operations via ArbitrageTimelock
 */

const { ethers } = require("ethers");

// ArbitrageTimelock ABI (OpenZeppelin TimelockController)
const TIMELOCK_ABI = [
  // State queries
  "function getMinDelay() external view returns (uint256)",
  "function isOperation(bytes32 id) external view returns (bool)",
  "function isOperationPending(bytes32 id) external view returns (bool)",
  "function isOperationReady(bytes32 id) external view returns (bool)",
  "function isOperationDone(bytes32 id) external view returns (bool)",
  "function getTimestamp(bytes32 id) external view returns (uint256)",

  // Role queries
  "function TIMELOCK_ADMIN_ROLE() external view returns (bytes32)",
  "function PROPOSER_ROLE() external view returns (bytes32)",
  "function EXECUTOR_ROLE() external view returns (bytes32)",
  "function CANCELLER_ROLE() external view returns (bytes32)",
  "function hasRole(bytes32 role, address account) external view returns (bool)",

  // Operations
  "function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) external",
  "function scheduleBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata payloads, bytes32 predecessor, bytes32 salt, uint256 delay) external",
  "function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt) external payable",
  "function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata payloads, bytes32 predecessor, bytes32 salt) external payable",
  "function cancel(bytes32 id) external",

  // Events
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
];

// ArbitrageFlashloan admin functions ABI
const ARBITRAGE_ADMIN_ABI = [
  "function scheduleProfitRecipientChange(address _newRecipient) external",
  "function executeProfitRecipientChange(address _newRecipient) external",
  "function pause() external",
  "function unpause() external",
  "function withdrawProfit(address token, uint256 amount) external",
  "function withdrawAllProfit(address token) external",
  "function transferOwnership(address newOwner) external",
];

// State
let timelockContract = null;
let arbitrageContract = null;
let provider = null;
let signer = null;

/**
 * Initialize timelock client
 * @param {Object} params - Initialization parameters
 */
async function initTimelockClient(params) {
  const {
    timelockAddress,
    arbitrageAddress,
    provider: _provider,
    signer: _signer,
  } = params;

  provider = _provider;
  signer = _signer;

  timelockContract = new ethers.Contract(
    timelockAddress,
    TIMELOCK_ABI,
    signer || provider
  );

  if (arbitrageAddress) {
    arbitrageContract = new ethers.Contract(
      arbitrageAddress,
      ARBITRAGE_ADMIN_ABI,
      signer || provider
    );
  }

  console.log(`[timelockUtils] Initialized timelock at ${timelockAddress}`);

  return {
    timelock: timelockContract,
    arbitrage: arbitrageContract,
    minDelay: await timelockContract.getMinDelay(),
  };
}

/**
 * Compute operation ID for a scheduled call
 * @param {string} target - Target contract address
 * @param {BigNumber} value - ETH value
 * @param {string} data - Encoded function call
 * @param {bytes32} predecessor - Predecessor operation ID
 * @param {bytes32} salt - Salt for uniqueness
 * @returns {string} - Operation ID (bytes32)
 */
function computeOperationId(target, value, data, predecessor, salt) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "bytes", "bytes32", "bytes32"],
      [target, value, data, predecessor, salt]
    )
  );
}

/**
 * Schedule a timelock operation
 * @param {Object} params - Operation parameters
 * @returns {Object} - Schedule result
 */
async function scheduleOperation(params) {
  const {
    target,
    value = 0,
    data,
    predecessor = ethers.constants.HashZero,
    salt = ethers.constants.HashZero,
    delay, // Optional: use min delay if not specified
    description,
  } = params;

  if (!timelockContract || !signer) {
    throw new Error("Timelock client not initialized with signer");
  }

  const actualDelay = delay || (await timelockContract.getMinDelay());
  const operationId = computeOperationId(
    target,
    value,
    data,
    predecessor,
    salt
  );

  // Check if already scheduled
  const isOperation = await timelockContract.isOperation(operationId);
  if (isOperation) {
    return {
      success: false,
      reason: "Operation already scheduled",
      operationId,
    };
  }

  // Check proposer role
  const proposerRole = await timelockContract.PROPOSER_ROLE();
  const hasRole = await timelockContract.hasRole(
    proposerRole,
    await signer.getAddress()
  );
  if (!hasRole) {
    return {
      success: false,
      reason: "Signer does not have PROPOSER_ROLE",
    };
  }

  try {
    const tx = await timelockContract.schedule(
      target,
      value,
      data,
      predecessor,
      salt,
      actualDelay
    );
    const receipt = await tx.wait();

    const executeAfter = Math.floor(Date.now() / 1000) + actualDelay.toNumber();

    console.log(`[timelockUtils] Scheduled operation ${operationId}`);
    console.log(
      `[timelockUtils] Executable after: ${new Date(
        executeAfter * 1000
      ).toISOString()}`
    );

    return {
      success: true,
      operationId,
      txHash: tx.hash,
      delay: actualDelay.toString(),
      executeAfter,
      description,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Execute a scheduled operation
 * @param {Object} params - Operation parameters
 * @returns {Object} - Execution result
 */
async function executeOperation(params) {
  const {
    target,
    value = 0,
    data,
    predecessor = ethers.constants.HashZero,
    salt = ethers.constants.HashZero,
  } = params;

  if (!timelockContract || !signer) {
    throw new Error("Timelock client not initialized with signer");
  }

  const operationId = computeOperationId(
    target,
    value,
    data,
    predecessor,
    salt
  );

  // Check operation status
  const isReady = await timelockContract.isOperationReady(operationId);
  if (!isReady) {
    const isPending = await timelockContract.isOperationPending(operationId);
    if (isPending) {
      const timestamp = await timelockContract.getTimestamp(operationId);
      return {
        success: false,
        reason: "Operation not yet ready",
        operationId,
        readyAt: timestamp.toString(),
        readyAtDate: new Date(timestamp.toNumber() * 1000).toISOString(),
      };
    }
    return {
      success: false,
      reason: "Operation not found or already executed",
      operationId,
    };
  }

  // Check executor role
  const executorRole = await timelockContract.EXECUTOR_ROLE();
  const hasRole = await timelockContract.hasRole(
    executorRole,
    await signer.getAddress()
  );
  if (!hasRole) {
    return {
      success: false,
      reason: "Signer does not have EXECUTOR_ROLE",
    };
  }

  try {
    const tx = await timelockContract.execute(
      target,
      value,
      data,
      predecessor,
      salt,
      { value }
    );
    const receipt = await tx.wait();

    console.log(`[timelockUtils] Executed operation ${operationId}`);

    return {
      success: true,
      operationId,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Cancel a pending operation
 * @param {string} operationId - Operation ID to cancel
 * @returns {Object} - Cancel result
 */
async function cancelOperation(operationId) {
  if (!timelockContract || !signer) {
    throw new Error("Timelock client not initialized with signer");
  }

  const isPending = await timelockContract.isOperationPending(operationId);
  if (!isPending) {
    return {
      success: false,
      reason: "Operation not pending",
    };
  }

  // Check canceller role
  const cancellerRole = await timelockContract.CANCELLER_ROLE();
  const hasRole = await timelockContract.hasRole(
    cancellerRole,
    await signer.getAddress()
  );
  if (!hasRole) {
    return {
      success: false,
      reason: "Signer does not have CANCELLER_ROLE",
    };
  }

  try {
    const tx = await timelockContract.cancel(operationId);
    await tx.wait();

    return {
      success: true,
      operationId,
      txHash: tx.hash,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Get operation status
 * @param {string} operationId - Operation ID
 * @returns {Object} - Operation status
 */
async function getOperationStatus(operationId) {
  if (!timelockContract) {
    throw new Error("Timelock client not initialized");
  }

  const [isOperation, isPending, isReady, isDone, timestamp] =
    await Promise.all([
      timelockContract.isOperation(operationId),
      timelockContract.isOperationPending(operationId),
      timelockContract.isOperationReady(operationId),
      timelockContract.isOperationDone(operationId),
      timelockContract.getTimestamp(operationId),
    ]);

  let status = "unknown";
  if (!isOperation) status = "not_scheduled";
  else if (isDone) status = "executed";
  else if (isReady) status = "ready";
  else if (isPending) status = "pending";

  return {
    operationId,
    status,
    isOperation,
    isPending,
    isReady,
    isDone,
    timestamp: timestamp.toString(),
    readyAt: timestamp.gt(0)
      ? new Date(timestamp.toNumber() * 1000).toISOString()
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level governance operations for ArbitrageFlashloan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schedule emergency pause
 */
async function schedulePause() {
  if (!arbitrageContract) {
    throw new Error("Arbitrage contract not configured");
  }

  const data = arbitrageContract.interface.encodeFunctionData("pause", []);

  return scheduleOperation({
    target: arbitrageContract.address,
    data,
    description: "Emergency pause",
  });
}

/**
 * Schedule unpause
 */
async function scheduleUnpause() {
  if (!arbitrageContract) {
    throw new Error("Arbitrage contract not configured");
  }

  const data = arbitrageContract.interface.encodeFunctionData("unpause", []);

  return scheduleOperation({
    target: arbitrageContract.address,
    data,
    description: "Unpause contract",
  });
}

/**
 * Get all roles for an address
 * @param {string} address - Address to check
 */
async function getRoles(address) {
  if (!timelockContract) {
    throw new Error("Timelock client not initialized");
  }

  const [adminRole, proposerRole, executorRole, cancellerRole] =
    await Promise.all([
      timelockContract.TIMELOCK_ADMIN_ROLE(),
      timelockContract.PROPOSER_ROLE(),
      timelockContract.EXECUTOR_ROLE(),
      timelockContract.CANCELLER_ROLE(),
    ]);

  const [isAdmin, isProposer, isExecutor, isCanceller] = await Promise.all([
    timelockContract.hasRole(adminRole, address),
    timelockContract.hasRole(proposerRole, address),
    timelockContract.hasRole(executorRole, address),
    timelockContract.hasRole(cancellerRole, address),
  ]);

  return {
    address,
    roles: {
      admin: isAdmin,
      proposer: isProposer,
      executor: isExecutor,
      canceller: isCanceller,
    },
  };
}

module.exports = {
  initTimelockClient,
  computeOperationId,
  scheduleOperation,
  executeOperation,
  cancelOperation,
  getOperationStatus,
  schedulePause,
  scheduleUnpause,
  getRoles,
  TIMELOCK_ABI,
  ARBITRAGE_ADMIN_ABI,
};
