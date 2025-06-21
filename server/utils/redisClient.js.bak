// server/utils/redisClient.js

/**
 * Thin wrapper around ioredis providing the minimal Redis operations used in
 * the project. If REDIS_URL is unset, the client connects to localhost by
 * default.
 */

const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const client = new Redis(REDIS_URL);

async function get(key) {
  return client.get(key);
}

async function set(key, value, option, ttl) {
  if (option && ttl) {
    return client.set(key, value, option, ttl);
  }
  return client.set(key, value);
}

async function hmset(key, ...args) {
  return client.hmset(key, ...args);
}

async function hgetall(key) {
  return client.hgetall(key);
}

module.exports = {
  get,
  set,
  hmset,
  hgetall,
};
