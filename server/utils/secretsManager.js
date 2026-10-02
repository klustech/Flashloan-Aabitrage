/**
 * server/utils/secretsManager.js
 *
 * Secure Secrets Management for Flash Loan Arbitrage Bot
 * Supports multiple secret sources:
 * - Environment variables
 * - Encrypted JSON files (AES-256-GCM)
 * - AWS Secrets Manager (optional)
 * - Azure Key Vault (optional)
 * - HashiCorp Vault (optional)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Secret source types
const SecretSource = {
  ENV: "env",
  ENCRYPTED_FILE: "encrypted_file",
  AWS_SECRETS_MANAGER: "aws",
  AZURE_KEY_VAULT: "azure",
  HASHICORP_VAULT: "vault",
};

// Required secrets for production operation
const REQUIRED_SECRETS = {
  PRIVATE_KEY: {
    description: "Wallet private key for signing transactions",
    sensitive: true,
    validator: (val) => /^(0x)?[a-fA-F0-9]{64}$/.test(val),
  },
  MAINNET_RPC_URL: {
    description: "Ethereum mainnet RPC endpoint",
    sensitive: false,
    validator: (val) => val.startsWith("http") || val.startsWith("wss"),
  },
  CONTRACT_ADDRESS: {
    description: "Deployed ArbitrageFlashloan contract address",
    sensitive: false,
    validator: (val) => /^0x[a-fA-F0-9]{40}$/.test(val),
  },
  AAVE_LENDING_POOL_ADDRESS_PROVIDER: {
    description: "Aave LendingPoolAddressesProvider contract",
    sensitive: false,
    validator: (val) => /^0x[a-fA-F0-9]{40}$/.test(val),
  },
};

// Optional secrets with defaults
const OPTIONAL_SECRETS = {
  SLACK_WEBHOOK_URL: {
    description: "Slack webhook for alerts",
    sensitive: true,
    validator: (val) => !val || val.startsWith("https://hooks.slack.com"),
  },
  ML_MODEL_ENDPOINT: {
    description: "ML scoring service endpoint",
    sensitive: false,
    validator: (val) => !val || val.startsWith("http"),
  },
  CONNEXT_ADAPTER_ADDRESS: {
    description: "Connext cross-chain adapter contract",
    sensitive: false,
    validator: (val) => !val || /^0x[a-fA-F0-9]{40}$/.test(val),
  },
  DATABASE_URL: {
    description: "PostgreSQL connection string",
    sensitive: true,
    validator: (val) => !val || val.startsWith("postgres"),
  },
  REDIS_URL: {
    description: "Redis connection string",
    sensitive: true,
    validator: (val) => !val || val.startsWith("redis"),
  },
};

// Encryption helpers
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Derive encryption key from password using PBKDF2
 * @param {string} password - Master password
 * @param {Buffer} salt - Salt for key derivation
 * @returns {Buffer} Derived key
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, "sha512");
}

/**
 * Encrypt secrets object to a file
 * @param {Object} secrets - Secrets object to encrypt
 * @param {string} password - Master password
 * @param {string} filePath - Output file path
 */
function encryptSecretsToFile(secrets, password, filePath) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(secrets);

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");

  const authTag = cipher.getAuthTag();

  const payload = {
    version: 1,
    algorithm: ALGORITHM,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    data: encrypted,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return { success: true, path: filePath };
}

/**
 * Decrypt secrets from an encrypted file
 * @param {string} filePath - Encrypted file path
 * @param {string} password - Master password
 * @returns {Object} Decrypted secrets
 */
function decryptSecretsFromFile(filePath, password) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Encrypted secrets file not found: ${filePath}`);
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (payload.version !== 1) {
    throw new Error(`Unsupported secrets file version: ${payload.version}`);
  }

  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const key = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(payload.data, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted);
}

/**
 * Load secrets from AWS Secrets Manager (stub for integration)
 * @param {string} secretName - AWS secret name
 * @param {string} region - AWS region
 * @returns {Promise<Object>} Secrets object
 */
async function loadFromAWSSecretsManager(secretName, region = "us-east-1") {
  // Check if AWS SDK is available
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const client = new SecretsManagerClient({ region });
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

    if (response.SecretString) {
      return JSON.parse(response.SecretString);
    }
    throw new Error("Binary secrets not supported");
  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "AWS SDK not installed. Run: npm install @aws-sdk/client-secrets-manager"
      );
    }
    throw err;
  }
}

/**
 * Load secrets from Azure Key Vault (stub for integration)
 * @param {string} vaultUrl - Azure Key Vault URL
 * @param {string[]} secretNames - List of secret names to load
 * @returns {Promise<Object>} Secrets object
 */
async function loadFromAzureKeyVault(vaultUrl, secretNames) {
  try {
    const { DefaultAzureCredential } = require("@azure/identity");
    const { SecretClient } = require("@azure/keyvault-secrets");

    const credential = new DefaultAzureCredential();
    const client = new SecretClient(vaultUrl, credential);

    const secrets = {};
    for (const name of secretNames) {
      const secret = await client.getSecret(name);
      secrets[name] = secret.value;
    }
    return secrets;
  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "Azure SDK not installed. Run: npm install @azure/identity @azure/keyvault-secrets"
      );
    }
    throw err;
  }
}

/**
 * Load secrets from HashiCorp Vault (stub for integration)
 * @param {string} vaultAddr - Vault server address
 * @param {string} secretPath - Secret path in Vault
 * @param {string} token - Vault token
 * @returns {Promise<Object>} Secrets object
 */
async function loadFromHashiCorpVault(vaultAddr, secretPath, token) {
  const axios = require("axios");

  const response = await axios.get(`${vaultAddr}/v1/${secretPath}`, {
    headers: { "X-Vault-Token": token },
    timeout: 10000,
  });

  return response.data.data.data || response.data.data;
}

/**
 * SecretsManager class for managing application secrets
 */
class SecretsManager {
  constructor(options = {}) {
    this.source = options.source || SecretSource.ENV;
    this.secrets = {};
    this.loaded = false;
    this.validationErrors = [];
    this.options = options;
  }

  /**
   * Load secrets from the configured source
   * @returns {Promise<boolean>} Success status
   */
  async load() {
    try {
      switch (this.source) {
        case SecretSource.ENV:
          this.secrets = this._loadFromEnv();
          break;

        case SecretSource.ENCRYPTED_FILE:
          if (!this.options.filePath || !this.options.password) {
            throw new Error(
              "Encrypted file source requires filePath and password options"
            );
          }
          this.secrets = decryptSecretsFromFile(
            this.options.filePath,
            this.options.password
          );
          break;

        case SecretSource.AWS_SECRETS_MANAGER:
          if (!this.options.secretName) {
            throw new Error("AWS source requires secretName option");
          }
          this.secrets = await loadFromAWSSecretsManager(
            this.options.secretName,
            this.options.region
          );
          break;

        case SecretSource.AZURE_KEY_VAULT:
          if (!this.options.vaultUrl || !this.options.secretNames) {
            throw new Error(
              "Azure source requires vaultUrl and secretNames options"
            );
          }
          this.secrets = await loadFromAzureKeyVault(
            this.options.vaultUrl,
            this.options.secretNames
          );
          break;

        case SecretSource.HASHICORP_VAULT:
          if (!this.options.vaultAddr || !this.options.secretPath) {
            throw new Error(
              "Vault source requires vaultAddr and secretPath options"
            );
          }
          this.secrets = await loadFromHashiCorpVault(
            this.options.vaultAddr,
            this.options.secretPath,
            this.options.token || process.env.VAULT_TOKEN
          );
          break;

        default:
          throw new Error(`Unknown secret source: ${this.source}`);
      }

      this.loaded = true;
      return true;
    } catch (err) {
      console.error(`[SecretsManager] Failed to load secrets: ${err.message}`);
      return false;
    }
  }

  /**
   * Load secrets from environment variables
   * @returns {Object} Secrets object
   */
  _loadFromEnv() {
    const secrets = {};
    const allSecrets = { ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS };

    for (const key of Object.keys(allSecrets)) {
      if (process.env[key]) {
        secrets[key] = process.env[key];
      }
    }

    return secrets;
  }

  /**
   * Get a secret value
   * @param {string} key - Secret key
   * @param {*} defaultValue - Default value if not found
   * @returns {string|*} Secret value or default
   */
  get(key, defaultValue = undefined) {
    if (!this.loaded) {
      // Fall back to environment variable if not loaded
      return process.env[key] || defaultValue;
    }
    return this.secrets[key] || process.env[key] || defaultValue;
  }

  /**
   * Check if a secret exists
   * @param {string} key - Secret key
   * @returns {boolean}
   */
  has(key) {
    return !!this.get(key);
  }

  /**
   * Validate all required secrets are present and valid
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate() {
    this.validationErrors = [];

    // Check required secrets
    for (const [key, config] of Object.entries(REQUIRED_SECRETS)) {
      const value = this.get(key);

      if (!value) {
        this.validationErrors.push(
          `Missing required secret: ${key} - ${config.description}`
        );
        continue;
      }

      if (config.validator && !config.validator(value)) {
        this.validationErrors.push(
          `Invalid format for secret: ${key} - ${config.description}`
        );
      }
    }

    // Validate optional secrets if present
    for (const [key, config] of Object.entries(OPTIONAL_SECRETS)) {
      const value = this.get(key);

      if (value && config.validator && !config.validator(value)) {
        this.validationErrors.push(
          `Invalid format for optional secret: ${key} - ${config.description}`
        );
      }
    }

    return {
      valid: this.validationErrors.length === 0,
      errors: this.validationErrors,
    };
  }

  /**
   * Get validation status with masked secrets for logging
   * @returns {Object} Status object safe for logging
   */
  getStatus() {
    const status = {
      source: this.source,
      loaded: this.loaded,
      validation: this.validate(),
      secrets: {},
    };

    // Include masked representation of secrets
    const allSecrets = { ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS };
    for (const [key, config] of Object.entries(allSecrets)) {
      const value = this.get(key);
      status.secrets[key] = {
        present: !!value,
        sensitive: config.sensitive,
        masked: value
          ? config.sensitive
            ? "[redacted...]"
            : value.substring(0, 20) + (value.length > 20 ? "..." : "")
          : null,
      };
    }

    return status;
  }

  /**
   * Require all secrets to be valid, throw if not
   */
  requireValid() {
    const validation = this.validate();
    if (!validation.valid) {
      const errorMsg = `Secret validation failed:\n${validation.errors.join("\n")}`;
      throw new Error(errorMsg);
    }
  }
}

/**
 * Create and initialize a SecretsManager instance
 * Auto-detects source based on environment
 * @returns {Promise<SecretsManager>}
 */
async function createSecretsManager() {
  let source = SecretSource.ENV;
  const options = {};

  // Check for encrypted file source
  if (process.env.SECRETS_FILE && process.env.SECRETS_PASSWORD) {
    source = SecretSource.ENCRYPTED_FILE;
    options.filePath = process.env.SECRETS_FILE;
    options.password = process.env.SECRETS_PASSWORD;
  }
  // Check for AWS Secrets Manager
  else if (process.env.AWS_SECRET_NAME) {
    source = SecretSource.AWS_SECRETS_MANAGER;
    options.secretName = process.env.AWS_SECRET_NAME;
    options.region = process.env.AWS_REGION || "us-east-1";
  }
  // Check for Azure Key Vault
  else if (process.env.AZURE_VAULT_URL) {
    source = SecretSource.AZURE_KEY_VAULT;
    options.vaultUrl = process.env.AZURE_VAULT_URL;
    options.secretNames = Object.keys({
      ...REQUIRED_SECRETS,
      ...OPTIONAL_SECRETS,
    });
  }
  // Check for HashiCorp Vault
  else if (process.env.VAULT_ADDR && process.env.VAULT_SECRET_PATH) {
    source = SecretSource.HASHICORP_VAULT;
    options.vaultAddr = process.env.VAULT_ADDR;
    options.secretPath = process.env.VAULT_SECRET_PATH;
  }

  const manager = new SecretsManager({ source, ...options });
  await manager.load();

  return manager;
}

// CLI utility for encrypting secrets
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "encrypt") {
    const inputFile = args[1];
    const outputFile = args[2];
    const password = args[3] || process.env.SECRETS_PASSWORD;

    if (!inputFile || !outputFile || !password) {
      console.log("Usage: node secretsManager.js encrypt <input.json> <output.encrypted> <password>");
      console.log("  Or set SECRETS_PASSWORD environment variable");
      process.exit(1);
    }

    try {
      const secrets = JSON.parse(fs.readFileSync(inputFile, "utf8"));
      encryptSecretsToFile(secrets, password, outputFile);
      console.log(`Encrypted secrets written to: ${outputFile}`);
      console.log("Store this file securely and delete the plaintext input file.");
    } catch (err) {
      console.error(`Error encrypting secrets: ${err.message}`);
      process.exit(1);
    }
  } else if (command === "decrypt") {
    const inputFile = args[1];
    const password = args[2] || process.env.SECRETS_PASSWORD;

    if (!inputFile || !password) {
      console.log("Usage: node secretsManager.js decrypt <input.encrypted> <password>");
      process.exit(1);
    }

    try {
      const secrets = decryptSecretsFromFile(inputFile, password);
      console.log("Decrypted secrets (keys only):");
      console.log(Object.keys(secrets).join("\n"));
    } catch (err) {
      console.error(`Error decrypting secrets: ${err.message}`);
      process.exit(1);
    }
  } else if (command === "validate") {
    createSecretsManager().then((manager) => {
      const status = manager.getStatus();
      console.log("\nSecrets Manager Status:");
      console.log(`Source: ${status.source}`);
      console.log(`Loaded: ${status.loaded}`);
      console.log(`Valid: ${status.validation.valid}`);

      if (!status.validation.valid) {
        console.log("\nValidation Errors:");
        status.validation.errors.forEach((err) => console.log(`  - ${err}`));
      }

      console.log("\nSecrets:");
      for (const [key, info] of Object.entries(status.secrets)) {
        const indicator = info.present ? "✓" : "✗";
        console.log(`  ${indicator} ${key}: ${info.present ? info.masked : "(missing)"}`);
      }

      process.exit(status.validation.valid ? 0 : 1);
    });
  } else if (command === "template") {
    // Generate a template secrets file
    const template = {};
    const allSecrets = { ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS };

    for (const [key, config] of Object.entries(allSecrets)) {
      template[key] = `<${config.description}>`;
    }

    console.log(JSON.stringify(template, null, 2));
  } else {
    console.log("Secrets Manager CLI");
    console.log("");
    console.log("Commands:");
    console.log("  encrypt <input.json> <output.encrypted> <password>  - Encrypt a secrets file");
    console.log("  decrypt <input.encrypted> <password>                - Decrypt and show keys");
    console.log("  validate                                            - Validate current secrets");
    console.log("  template                                            - Generate template JSON");
    console.log("");
    console.log("Environment Variables:");
    console.log("  SECRETS_FILE + SECRETS_PASSWORD  - Use encrypted file source");
    console.log("  AWS_SECRET_NAME + AWS_REGION     - Use AWS Secrets Manager");
    console.log("  AZURE_VAULT_URL                  - Use Azure Key Vault");
    console.log("  VAULT_ADDR + VAULT_SECRET_PATH   - Use HashiCorp Vault");
  }
}

module.exports = {
  SecretSource,
  SecretsManager,
  createSecretsManager,
  encryptSecretsToFile,
  decryptSecretsFromFile,
  REQUIRED_SECRETS,
  OPTIONAL_SECRETS,
};

