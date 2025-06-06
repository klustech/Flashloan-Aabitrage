// server/utils/redisClient.js

/**
 * A stubbed Redis client that does nothing.
 * This prevents "Cannot find module 'ioredis'" errors.
 *
 * Any code that does:
 *   const redis = require("../utils/redisClient");
 *   await redis.get(key);
 *   await redis.set(key, value, "EX", ttl);
 *   await redis.hmset(key, ...);
 *   const data = await redis.hgetall(key);
 *
 * will still compile, but simply be a no-op or return null/empty object.
 */

async function get(key) {
  // No-op: always return null
  return null;
}

async function set(key, value, option, ttl) {
  // No-op
  return null;
}

async function hmset(key, field1, value1, field2, value2, field3, value3) {
  // No-op
  return null;
}

async function hgetall(key) {
  // Always return an empty object
  return {};
}

module.exports = {
  get,
  set,
  hmset,
  hgetall,
};
