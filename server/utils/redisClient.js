/**
 * Redis Client - Enhanced wrapper with distributed locking and caching
 * Supports: Connection management, distributed locks, leader election, caching
 */

const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const INSTANCE_ID = process.env.INSTANCE_ID || `bot-${process.pid}-${Date.now()}`;

let client = null;
let isConnected = false;
let connectionPromise = null;

/**
 * Initialize Redis connection with retry logic
 */
async function initRedis() {
  if (connectionPromise) return connectionPromise;

  connectionPromise = new Promise((resolve, reject) => {
    try {
      client = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 100, 3000);
          console.log(`[Redis] Retry attempt ${times}, waiting ${delay}ms`);
          return delay;
        },
        reconnectOnError(err) {
          const targetErrors = ["READONLY", "ECONNRESET", "ETIMEDOUT"];
          return targetErrors.some(e => err.message.includes(e));
        },
      });

      client.on("connect", () => {
        console.log("[Redis] Connected successfully");
        isConnected = true;
      });

      client.on("error", (err) => {
        console.error("[Redis] Connection error:", err.message);
        isConnected = false;
      });

      client.on("close", () => {
        console.log("[Redis] Connection closed");
        isConnected = false;
      });

      client.on("ready", () => {
        resolve(client);
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!isConnected) {
          console.warn("[Redis] Connection timeout - continuing without Redis");
          resolve(null);
        }
      }, 5000);
    } catch (err) {
      console.error("[Redis] Failed to initialize:", err.message);
      resolve(null);
    }
  });

  return connectionPromise;
}

/**
 * Get Redis client (lazy initialization)
 */
async function getClient() {
  if (!client) {
    await initRedis();
  }
  return client;
}

/**
 * Check if Redis is available
 */
function isAvailable() {
  return isConnected && client !== null;
}

// ─── Basic Operations ───────────────────────────────────────────────────────

async function get(key) {
  if (!isAvailable()) return null;
  try {
    return await client.get(key);
  } catch (err) {
    console.error(`[Redis] GET error for ${key}:`, err.message);
    return null;
  }
}

async function set(key, value, option, ttl) {
  if (!isAvailable()) return false;
  try {
    if (option && ttl) {
      await client.set(key, value, option, ttl);
    } else {
      await client.set(key, value);
    }
    return true;
  } catch (err) {
    console.error(`[Redis] SET error for ${key}:`, err.message);
    return false;
  }
}

async function del(key) {
  if (!isAvailable()) return false;
  try {
    await client.del(key);
    return true;
  } catch (err) {
    console.error(`[Redis] DEL error for ${key}:`, err.message);
    return false;
  }
}

async function hmset(key, ...args) {
  if (!isAvailable()) return false;
  try {
    await client.hmset(key, ...args);
    return true;
  } catch (err) {
    console.error(`[Redis] HMSET error for ${key}:`, err.message);
    return false;
  }
}

async function hgetall(key) {
  if (!isAvailable()) return null;
  try {
    return await client.hgetall(key);
  } catch (err) {
    console.error(`[Redis] HGETALL error for ${key}:`, err.message);
    return null;
  }
}

// ─── Distributed Lock ───────────────────────────────────────────────────────

const LOCK_PREFIX = "lock:";
const DEFAULT_LOCK_TTL = 60; // seconds

/**
 * Acquire a distributed lock
 * @param {string} lockName - Name of the lock
 * @param {number} ttlSeconds - Lock TTL in seconds (default 60)
 * @returns {Promise<boolean>} - True if lock acquired, false otherwise
 */
async function acquireLock(lockName, ttlSeconds = DEFAULT_LOCK_TTL) {
  if (!isAvailable()) {
    console.warn("[Redis] Not available - lock acquisition skipped");
    return true; // Allow operation in single-instance mode
  }

  const lockKey = `${LOCK_PREFIX}${lockName}`;
  const lockValue = INSTANCE_ID;

  try {
    // SET NX with expiration (atomic operation)
    const result = await client.set(lockKey, lockValue, "NX", "EX", ttlSeconds);
    const acquired = result === "OK";

    if (acquired) {
      console.log(`[Redis] Lock acquired: ${lockName} by ${INSTANCE_ID}`);
    }

    return acquired;
  } catch (err) {
    console.error(`[Redis] Lock acquisition error for ${lockName}:`, err.message);
    return true; // Fail open in single-instance mode
  }
}

/**
 * Release a distributed lock
 * @param {string} lockName - Name of the lock
 * @returns {Promise<boolean>} - True if lock released, false otherwise
 */
async function releaseLock(lockName) {
  if (!isAvailable()) return true;

  const lockKey = `${LOCK_PREFIX}${lockName}`;
  const lockValue = INSTANCE_ID;

  // Lua script to release lock only if we own it
  const releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  try {
    const result = await client.eval(releaseScript, 1, lockKey, lockValue);
    const released = result === 1;

    if (released) {
      console.log(`[Redis] Lock released: ${lockName} by ${INSTANCE_ID}`);
    }

    return released;
  } catch (err) {
    console.error(`[Redis] Lock release error for ${lockName}:`, err.message);
    return false;
  }
}

/**
 * Extend a lock's TTL
 * @param {string} lockName - Name of the lock
 * @param {number} ttlSeconds - New TTL in seconds
 * @returns {Promise<boolean>} - True if extended, false otherwise
 */
async function extendLock(lockName, ttlSeconds = DEFAULT_LOCK_TTL) {
  if (!isAvailable()) return true;

  const lockKey = `${LOCK_PREFIX}${lockName}`;
  const lockValue = INSTANCE_ID;

  // Lua script to extend only if we own the lock
  const extendScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("expire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  try {
    const result = await client.eval(extendScript, 1, lockKey, lockValue, ttlSeconds);
    return result === 1;
  } catch (err) {
    console.error(`[Redis] Lock extend error for ${lockName}:`, err.message);
    return false;
  }
}

// ─── Leader Election ────────────────────────────────────────────────────────

const LEADER_KEY = "arb:leader";
const LEADER_HEARTBEAT_INTERVAL = 10000; // 10 seconds
const LEADER_TTL = 30; // seconds

let isLeader = false;
let heartbeatInterval = null;

/**
 * Attempt to become the leader
 * @returns {Promise<boolean>} - True if this instance is now the leader
 */
async function tryBecomeLeader() {
  if (!isAvailable()) {
    isLeader = true; // Single instance mode
    return true;
  }

  try {
    const result = await client.set(LEADER_KEY, INSTANCE_ID, "NX", "EX", LEADER_TTL);
    isLeader = result === "OK";

    if (isLeader) {
      console.log(`[Redis] This instance (${INSTANCE_ID}) is now the leader`);
      startHeartbeat();
    }

    return isLeader;
  } catch (err) {
    console.error("[Redis] Leader election error:", err.message);
    return false;
  }
}

/**
 * Check if this instance is the leader
 * @returns {Promise<boolean>}
 */
async function checkIsLeader() {
  if (!isAvailable()) return true; // Single instance mode

  try {
    const currentLeader = await client.get(LEADER_KEY);
    isLeader = currentLeader === INSTANCE_ID;
    return isLeader;
  } catch (err) {
    console.error("[Redis] Leader check error:", err.message);
    return isLeader;
  }
}

/**
 * Start leader heartbeat to maintain leadership
 */
function startHeartbeat() {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(async () => {
    if (!isLeader) {
      stopHeartbeat();
      return;
    }

    try {
      // Extend leadership TTL
      const extended = await client.set(LEADER_KEY, INSTANCE_ID, "XX", "EX", LEADER_TTL);
      if (extended !== "OK") {
        console.warn("[Redis] Lost leadership - another instance took over");
        isLeader = false;
        stopHeartbeat();
      }
    } catch (err) {
      console.error("[Redis] Heartbeat error:", err.message);
    }
  }, LEADER_HEARTBEAT_INTERVAL);
}

/**
 * Stop leader heartbeat
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Resign from leadership
 */
async function resignLeadership() {
  if (!isAvailable() || !isLeader) return;

  stopHeartbeat();

  try {
    // Only delete if we're still the leader
    const releaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await client.eval(releaseScript, 1, LEADER_KEY, INSTANCE_ID);
    console.log(`[Redis] Resigned leadership: ${INSTANCE_ID}`);
  } catch (err) {
    console.error("[Redis] Resign leadership error:", err.message);
  }

  isLeader = false;
}

// ─── Caching ────────────────────────────────────────────────────────────────

const CACHE_PREFIX = "cache:";

/**
 * Get cached value or compute and cache it
 * @param {string} key - Cache key
 * @param {Function} computeFn - Function to compute value if not cached
 * @param {number} ttlSeconds - Cache TTL in seconds
 * @returns {Promise<any>} - Cached or computed value
 */
async function getOrCompute(key, computeFn, ttlSeconds = 60) {
  const cacheKey = `${CACHE_PREFIX}${key}`;

  if (isAvailable()) {
    try {
      const cached = await client.get(cacheKey);
      if (cached !== null) {
        return JSON.parse(cached);
      }
    } catch (err) {
      console.error(`[Redis] Cache get error for ${key}:`, err.message);
    }
  }

  // Compute value
  const value = await computeFn();

  // Cache it
  if (isAvailable() && value !== undefined) {
    try {
      await client.set(cacheKey, JSON.stringify(value), "EX", ttlSeconds);
    } catch (err) {
      console.error(`[Redis] Cache set error for ${key}:`, err.message);
    }
  }

  return value;
}

/**
 * Invalidate cache entry
 * @param {string} key - Cache key
 */
async function invalidateCache(key) {
  if (!isAvailable()) return;
  const cacheKey = `${CACHE_PREFIX}${key}`;
  await del(cacheKey);
}

// ─── Pub/Sub ────────────────────────────────────────────────────────────────

const subscribers = new Map();

/**
 * Subscribe to a channel
 * @param {string} channel - Channel name
 * @param {Function} handler - Message handler
 */
async function subscribe(channel, handler) {
  if (!isAvailable()) return;

  try {
    // Create a separate client for subscriptions
    const subClient = client.duplicate();
    await subClient.subscribe(channel);

    subClient.on("message", (ch, message) => {
      if (ch === channel) {
        try {
          const parsed = JSON.parse(message);
          handler(parsed);
        } catch {
          handler(message);
        }
      }
    });

    subscribers.set(channel, subClient);
    console.log(`[Redis] Subscribed to channel: ${channel}`);
  } catch (err) {
    console.error(`[Redis] Subscribe error for ${channel}:`, err.message);
  }
}

/**
 * Publish to a channel
 * @param {string} channel - Channel name
 * @param {any} message - Message to publish
 */
async function publish(channel, message) {
  if (!isAvailable()) return;

  try {
    const payload = typeof message === "string" ? message : JSON.stringify(message);
    await client.publish(channel, payload);
  } catch (err) {
    console.error(`[Redis] Publish error for ${channel}:`, err.message);
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log("[Redis] Shutting down...");

  await resignLeadership();

  // Close all subscriber connections
  for (const [channel, subClient] of subscribers) {
    try {
      await subClient.unsubscribe(channel);
      await subClient.quit();
    } catch (err) {
      console.error(`[Redis] Error closing subscriber for ${channel}:`, err.message);
    }
  }
  subscribers.clear();

  // Close main client
  if (client) {
    try {
      await client.quit();
    } catch (err) {
      console.error("[Redis] Error closing client:", err.message);
    }
  }

  isConnected = false;
  client = null;
  connectionPromise = null;
}

// Handle process termination
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = {
  // Initialization
  initRedis,
  getClient,
  isAvailable,

  // Basic operations
  get,
  set,
  del,
  hmset,
  hgetall,

  // Distributed locking
  acquireLock,
  releaseLock,
  extendLock,

  // Leader election
  tryBecomeLeader,
  checkIsLeader,
  resignLeadership,
  isLeader: () => isLeader,

  // Caching
  getOrCompute,
  invalidateCache,

  // Pub/Sub
  subscribe,
  publish,

  // Cleanup
  shutdown,

  // Constants
  INSTANCE_ID,
};
