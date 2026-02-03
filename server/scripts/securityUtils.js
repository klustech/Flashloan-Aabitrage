/**
 * server/scripts/securityUtils.js
 *
 * Security Utilities for Flash Loan Arbitrage Bot
 * - Key management and validation
 * - Secret rotation helpers
 * - API key validation
 * - Rate limiting utilities
 * - Audit logging
 */

const crypto = require("crypto");
const { ethers } = require("ethers");

// Configuration
const SECURITY_CONFIG = {
  // API key settings
  apiKeyLength: 32,
  apiKeyPrefix: "arb_",

  // Rate limiting
  defaultRateLimit: 100,    // requests per window
  rateLimitWindow: 60000,   // 1 minute

  // Key rotation
  keyRotationWarningDays: 30,
  maxKeyAgeDays: 90,

  // Audit logging
  enableAuditLog: true,
  sensitiveFields: ["privateKey", "password", "apiKey", "secret", "token"],
};

// In-memory rate limit tracking
const rateLimitStore = new Map();

/**
 * Validate Ethereum private key format
 * @param {string} key - Private key to validate
 * @returns {Object} - { valid, error? }
 */
function validatePrivateKey(key) {
  if (!key) {
    return { valid: false, error: "Private key is required" };
  }

  // Remove 0x prefix if present
  const cleanKey = key.startsWith("0x") ? key.slice(2) : key;

  // Check length (64 hex characters = 32 bytes)
  if (cleanKey.length !== 64) {
    return { valid: false, error: "Private key must be 32 bytes (64 hex characters)" };
  }

  // Check if valid hex
  if (!/^[0-9a-fA-F]+$/.test(cleanKey)) {
    return { valid: false, error: "Private key must be valid hexadecimal" };
  }

  // Try to create a wallet to validate
  try {
    new ethers.Wallet(key);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Invalid private key: ${err.message}` };
  }
}

/**
 * Validate address format
 * @param {string} address - Ethereum address
 * @returns {Object} - { valid, checksummed?, error? }
 */
function validateAddress(address) {
  if (!address) {
    return { valid: false, error: "Address is required" };
  }

  try {
    const checksummed = ethers.utils.getAddress(address);
    return {
      valid: true,
      checksummed,
      isChecksummed: address === checksummed,
    };
  } catch (err) {
    return { valid: false, error: "Invalid Ethereum address format" };
  }
}

/**
 * Generate a secure API key
 * @returns {string} - Generated API key
 */
function generateApiKey() {
  const randomBytes = crypto.randomBytes(SECURITY_CONFIG.apiKeyLength);
  return SECURITY_CONFIG.apiKeyPrefix + randomBytes.toString("hex");
}

/**
 * Validate API key format
 * @param {string} key - API key to validate
 * @returns {boolean}
 */
function validateApiKeyFormat(key) {
  if (!key || typeof key !== "string") return false;
  if (!key.startsWith(SECURITY_CONFIG.apiKeyPrefix)) return false;
  if (key.length !== SECURITY_CONFIG.apiKeyPrefix.length + SECURITY_CONFIG.apiKeyLength * 2) {
    return false;
  }
  return /^[a-f0-9]+$/.test(key.slice(SECURITY_CONFIG.apiKeyPrefix.length));
}

/**
 * Hash API key for storage
 * @param {string} key - API key to hash
 * @returns {string} - Hashed key
 */
function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Rate limiter middleware helper
 * @param {string} identifier - Unique identifier (IP, API key, etc.)
 * @param {Object} options - { limit, windowMs }
 * @returns {Object} - { allowed, remaining, resetTime }
 */
function checkRateLimit(identifier, options = {}) {
  const limit = options.limit || SECURITY_CONFIG.defaultRateLimit;
  const windowMs = options.windowMs || SECURITY_CONFIG.rateLimitWindow;
  const now = Date.now();

  let record = rateLimitStore.get(identifier);

  // Reset if window expired
  if (!record || now > record.resetTime) {
    record = {
      count: 0,
      resetTime: now + windowMs,
    };
  }

  record.count++;
  rateLimitStore.set(identifier, record);

  const allowed = record.count <= limit;
  const remaining = Math.max(0, limit - record.count);
  const resetIn = Math.max(0, record.resetTime - now);

  return {
    allowed,
    remaining,
    resetTime: record.resetTime,
    resetIn,
    limit,
  };
}

/**
 * Clear expired rate limit entries
 */
function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupRateLimits, 60000);

/**
 * Mask sensitive data for logging
 * @param {Object} data - Data object to mask
 * @returns {Object} - Masked data
 */
function maskSensitiveData(data) {
  if (!data || typeof data !== "object") return data;

  const masked = { ...data };

  for (const field of SECURITY_CONFIG.sensitiveFields) {
    if (masked[field]) {
      const value = String(masked[field]);
      if (value.length > 8) {
        masked[field] = value.slice(0, 4) + "****" + value.slice(-4);
      } else {
        masked[field] = "****";
      }
    }
  }

  // Recursively mask nested objects
  for (const key of Object.keys(masked)) {
    if (typeof masked[key] === "object" && masked[key] !== null) {
      masked[key] = maskSensitiveData(masked[key]);
    }
  }

  return masked;
}

/**
 * Create audit log entry
 * @param {Object} params - Log parameters
 * @returns {Object} - Audit log entry
 */
function createAuditLog(params) {
  const {
    action,
    actor,
    resource,
    details,
    result,
    ip,
  } = params;

  const entry = {
    timestamp: new Date().toISOString(),
    action,
    actor: actor || "system",
    resource,
    details: maskSensitiveData(details),
    result: result || "success",
    ip: ip || "internal",
    id: crypto.randomUUID(),
  };

  if (SECURITY_CONFIG.enableAuditLog) {
    // In production, send to audit log service
    console.log("[AUDIT]", JSON.stringify(entry));
  }

  return entry;
}

/**
 * Validate environment configuration
 * @returns {Object} - { valid, errors, warnings }
 */
function validateEnvironment() {
  const errors = [];
  const warnings = [];

  // Required variables
  const required = [
    "PRIVATE_KEY",
    "MAINNET_RPC_URL",
    "CONTRACT_ADDRESS",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  // Validate private key
  if (process.env.PRIVATE_KEY) {
    const keyValidation = validatePrivateKey(process.env.PRIVATE_KEY);
    if (!keyValidation.valid) {
      errors.push(`Invalid PRIVATE_KEY: ${keyValidation.error}`);
    }
  }

  // Validate contract address
  if (process.env.CONTRACT_ADDRESS) {
    const addrValidation = validateAddress(process.env.CONTRACT_ADDRESS);
    if (!addrValidation.valid) {
      errors.push(`Invalid CONTRACT_ADDRESS: ${addrValidation.error}`);
    }
  }

  // Security warnings
  if (process.env.NODE_ENV === "production") {
    if (!process.env.API_KEY) {
      warnings.push("API_KEY not set - API endpoints may be unprotected");
    }

    if (process.env.PRIVATE_KEY && !process.env.PRIVATE_KEY.startsWith("0x")) {
      warnings.push("PRIVATE_KEY should start with 0x prefix");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Secure comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean}
 */
function secureCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generate nonce for replay protection
 * @returns {string}
 */
function generateNonce() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Encrypt sensitive data
 * @param {string} data - Data to encrypt
 * @param {string} key - Encryption key (32 bytes hex)
 * @returns {string} - Encrypted data (iv:ciphertext)
 */
function encryptData(data, key) {
  const iv = crypto.randomBytes(16);
  const keyBuffer = Buffer.from(key, "hex");
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer, iv);

  let encrypted = cipher.update(data, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${encrypted}:${authTag}`;
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedData - Encrypted data (iv:ciphertext:authTag)
 * @param {string} key - Decryption key (32 bytes hex)
 * @returns {string} - Decrypted data
 */
function decryptData(encryptedData, key) {
  const [ivHex, encrypted, authTagHex] = encryptedData.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const keyBuffer = Buffer.from(key, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Express middleware for API key validation
 */
function apiKeyMiddleware(options = {}) {
  const { headerName = "x-api-key", required = true } = options;
  const validKeys = new Set(
    (process.env.VALID_API_KEYS || process.env.API_KEY || "")
      .split(",")
      .map(k => k.trim())
      .filter(Boolean)
  );

  return (req, res, next) => {
    const apiKey = req.headers[headerName.toLowerCase()];

    if (!apiKey) {
      if (required) {
        createAuditLog({
          action: "api_access",
          resource: req.path,
          result: "denied",
          details: { reason: "missing_api_key" },
          ip: req.ip,
        });
        return res.status(401).json({ error: "API key required" });
      }
      return next();
    }

    if (!validKeys.has(apiKey)) {
      createAuditLog({
        action: "api_access",
        resource: req.path,
        result: "denied",
        details: { reason: "invalid_api_key" },
        ip: req.ip,
      });
      return res.status(403).json({ error: "Invalid API key" });
    }

    // Check rate limit
    const rateCheck = checkRateLimit(`api:${hashApiKey(apiKey)}`);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfter: Math.ceil(rateCheck.resetIn / 1000),
      });
    }

    req.apiKeyValid = true;
    next();
  };
}

module.exports = {
  validatePrivateKey,
  validateAddress,
  generateApiKey,
  validateApiKeyFormat,
  hashApiKey,
  checkRateLimit,
  maskSensitiveData,
  createAuditLog,
  validateEnvironment,
  secureCompare,
  generateNonce,
  encryptData,
  decryptData,
  apiKeyMiddleware,
  SECURITY_CONFIG,
};
