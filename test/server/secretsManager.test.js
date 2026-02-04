/**
 * test/server/secretsManager.test.js
 *
 * Unit tests for the SecretsManager utility
 */

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const {
  SecretsManager,
  SecretSource,
  createSecretsManager,
  encryptSecretsToFile,
  decryptSecretsFromFile,
  REQUIRED_SECRETS,
  OPTIONAL_SECRETS,
} = require("../../server/utils/secretsManager");

describe("SecretsManager", function () {
  const testDir = path.join(os.tmpdir(), "secrets-manager-test-" + Date.now());
  const testSecretsFile = path.join(testDir, "secrets.encrypted");
  const testPassword = "test-password-123";

  before(() => {
    // Create temp directory for tests
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  after(() => {
    // Clean up temp files
    try {
      if (fs.existsSync(testSecretsFile)) {
        fs.unlinkSync(testSecretsFile);
      }
      fs.rmdirSync(testDir);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Encryption/Decryption Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Encryption/Decryption", () => {
    const testSecrets = {
      PRIVATE_KEY: "0x" + crypto.randomBytes(32).toString("hex"),
      MAINNET_RPC_URL: "https://eth-mainnet.alchemyapi.io/v2/test-key",
      CONTRACT_ADDRESS: "0x" + crypto.randomBytes(20).toString("hex"),
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test/path",
    };

    it("should encrypt secrets to a file", () => {
      const result = encryptSecretsToFile(testSecrets, testPassword, testSecretsFile);

      expect(result).to.have.property("success", true);
      expect(result).to.have.property("path", testSecretsFile);
      expect(fs.existsSync(testSecretsFile)).to.be.true;

      // Verify file structure
      const fileContent = JSON.parse(fs.readFileSync(testSecretsFile, "utf8"));
      expect(fileContent).to.have.property("version", 1);
      expect(fileContent).to.have.property("algorithm");
      expect(fileContent).to.have.property("salt");
      expect(fileContent).to.have.property("iv");
      expect(fileContent).to.have.property("authTag");
      expect(fileContent).to.have.property("data");
    });

    it("should decrypt secrets from a file", () => {
      // First encrypt
      encryptSecretsToFile(testSecrets, testPassword, testSecretsFile);

      // Then decrypt
      const decrypted = decryptSecretsFromFile(testSecretsFile, testPassword);

      expect(decrypted).to.deep.equal(testSecrets);
    });

    it("should fail decryption with wrong password", () => {
      encryptSecretsToFile(testSecrets, testPassword, testSecretsFile);

      expect(() => {
        decryptSecretsFromFile(testSecretsFile, "wrong-password");
      }).to.throw();
    });

    it("should fail decryption if file tampered", () => {
      encryptSecretsToFile(testSecrets, testPassword, testSecretsFile);

      // Tamper with the file
      const fileContent = JSON.parse(fs.readFileSync(testSecretsFile, "utf8"));
      fileContent.data = "tampered-data";
      fs.writeFileSync(testSecretsFile, JSON.stringify(fileContent), "utf8");

      expect(() => {
        decryptSecretsFromFile(testSecretsFile, testPassword);
      }).to.throw();
    });

    it("should throw error for non-existent file", () => {
      expect(() => {
        decryptSecretsFromFile("/non/existent/path.encrypted", testPassword);
      }).to.throw(/not found/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SecretsManager Class Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("SecretsManager Class", () => {
    describe("Environment Variable Source", () => {
      let originalEnv;

      before(() => {
        originalEnv = { ...process.env };
      });

      afterEach(() => {
        // Restore original environment
        Object.keys(process.env).forEach((key) => {
          if (!(key in originalEnv)) {
            delete process.env[key];
          }
        });
        Object.assign(process.env, originalEnv);
      });

      it("should load secrets from environment variables", async () => {
        process.env.PRIVATE_KEY = "0x" + "a".repeat(64);
        process.env.MAINNET_RPC_URL = "https://eth-mainnet.test.io/v2/key";
        process.env.CONTRACT_ADDRESS = "0x" + "b".repeat(40);
        process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER = "0x" + "c".repeat(40);

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();

        expect(manager.loaded).to.be.true;
        expect(manager.get("PRIVATE_KEY")).to.equal("0x" + "a".repeat(64));
        expect(manager.get("MAINNET_RPC_URL")).to.equal("https://eth-mainnet.test.io/v2/key");
      });

      it("should return default value for missing secret", async () => {
        delete process.env.SLACK_WEBHOOK_URL;

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();

        expect(manager.get("SLACK_WEBHOOK_URL", "default-url")).to.equal("default-url");
      });

      it("should check if secret exists", async () => {
        process.env.PRIVATE_KEY = "0x" + "a".repeat(64);
        delete process.env.ML_MODEL_ENDPOINT;

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();

        expect(manager.has("PRIVATE_KEY")).to.be.true;
        expect(manager.has("ML_MODEL_ENDPOINT")).to.be.false;
      });
    });

    describe("Encrypted File Source", () => {
      const encryptedFilePath = path.join(testDir, "manager-test.encrypted");

      it("should load secrets from encrypted file", async () => {
        const secrets = {
          PRIVATE_KEY: "0x" + "d".repeat(64),
          MAINNET_RPC_URL: "https://test.io/key",
          CONTRACT_ADDRESS: "0x" + "e".repeat(40),
          AAVE_LENDING_POOL_ADDRESS_PROVIDER: "0x" + "f".repeat(40),
        };

        encryptSecretsToFile(secrets, testPassword, encryptedFilePath);

        const manager = new SecretsManager({
          source: SecretSource.ENCRYPTED_FILE,
          filePath: encryptedFilePath,
          password: testPassword,
        });
        await manager.load();

        expect(manager.loaded).to.be.true;
        expect(manager.get("PRIVATE_KEY")).to.equal(secrets.PRIVATE_KEY);
      });

      it("should fail without filePath option", async () => {
        const manager = new SecretsManager({
          source: SecretSource.ENCRYPTED_FILE,
        });
        const result = await manager.load();

        expect(result).to.be.false;
      });

      it("should fail without password option", async () => {
        const manager = new SecretsManager({
          source: SecretSource.ENCRYPTED_FILE,
          filePath: encryptedFilePath,
        });
        const result = await manager.load();

        expect(result).to.be.false;
      });
    });

    describe("Validation", () => {
      let originalEnv;

      before(() => {
        originalEnv = { ...process.env };
      });

      afterEach(() => {
        Object.keys(process.env).forEach((key) => {
          if (!(key in originalEnv)) {
            delete process.env[key];
          }
        });
        Object.assign(process.env, originalEnv);
      });

      it("should validate required secrets", async () => {
        // Set valid required secrets
        process.env.PRIVATE_KEY = "0x" + "a".repeat(64);
        process.env.MAINNET_RPC_URL = "https://test.io";
        process.env.CONTRACT_ADDRESS = "0x" + "b".repeat(40);
        process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER = "0x" + "c".repeat(40);

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();
        const result = manager.validate();

        expect(result.valid).to.be.true;
        expect(result.errors).to.be.empty;
      });

      it("should report missing required secrets", async () => {
        // Clear required secrets
        delete process.env.PRIVATE_KEY;
        delete process.env.MAINNET_RPC_URL;
        delete process.env.CONTRACT_ADDRESS;
        delete process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER;

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();
        const result = manager.validate();

        expect(result.valid).to.be.false;
        expect(result.errors.length).to.be.greaterThan(0);
        expect(result.errors.some((e) => e.includes("PRIVATE_KEY"))).to.be.true;
      });

      it("should report invalid secret format", async () => {
        process.env.PRIVATE_KEY = "invalid-key"; // Invalid format
        process.env.MAINNET_RPC_URL = "https://test.io";
        process.env.CONTRACT_ADDRESS = "0x" + "b".repeat(40);
        process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER = "0x" + "c".repeat(40);

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();
        const result = manager.validate();

        expect(result.valid).to.be.false;
        expect(result.errors.some((e) => e.includes("Invalid format"))).to.be.true;
      });

      it("should validate optional secrets format if present", async () => {
        process.env.PRIVATE_KEY = "0x" + "a".repeat(64);
        process.env.MAINNET_RPC_URL = "https://test.io";
        process.env.CONTRACT_ADDRESS = "0x" + "b".repeat(40);
        process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER = "0x" + "c".repeat(40);
        process.env.SLACK_WEBHOOK_URL = "invalid-url"; // Invalid format

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();
        const result = manager.validate();

        expect(result.valid).to.be.false;
        expect(result.errors.some((e) => e.includes("SLACK_WEBHOOK_URL"))).to.be.true;
      });
    });

    describe("Status Reporting", () => {
      let originalEnv;

      before(() => {
        originalEnv = { ...process.env };
      });

      afterEach(() => {
        Object.keys(process.env).forEach((key) => {
          if (!(key in originalEnv)) {
            delete process.env[key];
          }
        });
        Object.assign(process.env, originalEnv);
      });

      it("should return masked status for logging", async () => {
        process.env.PRIVATE_KEY = "0x" + "a".repeat(64);
        process.env.MAINNET_RPC_URL = "https://eth-mainnet.alchemyapi.io/v2/very-long-api-key";
        process.env.CONTRACT_ADDRESS = "0x" + "b".repeat(40);
        process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER = "0x" + "c".repeat(40);

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();
        const status = manager.getStatus();

        expect(status).to.have.property("source", SecretSource.ENV);
        expect(status).to.have.property("loaded", true);
        expect(status).to.have.property("validation");
        expect(status).to.have.property("secrets");

        // Private key should be masked (sensitive)
        expect(status.secrets.PRIVATE_KEY.sensitive).to.be.true;
        expect(status.secrets.PRIVATE_KEY.masked).to.include("...");
        expect(status.secrets.PRIVATE_KEY.masked).to.not.include("aaaa");

        // RPC URL should be truncated but not fully masked
        expect(status.secrets.MAINNET_RPC_URL.sensitive).to.be.false;
      });

      it("should handle missing secrets in status", async () => {
        delete process.env.SLACK_WEBHOOK_URL;

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();
        const status = manager.getStatus();

        expect(status.secrets.SLACK_WEBHOOK_URL.present).to.be.false;
        expect(status.secrets.SLACK_WEBHOOK_URL.masked).to.be.null;
      });
    });

    describe("requireValid", () => {
      let originalEnv;

      before(() => {
        originalEnv = { ...process.env };
      });

      afterEach(() => {
        Object.keys(process.env).forEach((key) => {
          if (!(key in originalEnv)) {
            delete process.env[key];
          }
        });
        Object.assign(process.env, originalEnv);
      });

      it("should throw error when secrets are invalid", async () => {
        delete process.env.PRIVATE_KEY;

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();

        expect(() => manager.requireValid()).to.throw(/validation failed/i);
      });

      it("should not throw when secrets are valid", async () => {
        process.env.PRIVATE_KEY = "0x" + "a".repeat(64);
        process.env.MAINNET_RPC_URL = "https://test.io";
        process.env.CONTRACT_ADDRESS = "0x" + "b".repeat(40);
        process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER = "0x" + "c".repeat(40);

        const manager = new SecretsManager({ source: SecretSource.ENV });
        await manager.load();

        expect(() => manager.requireValid()).to.not.throw();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Auto-Detection Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Auto-Detection", () => {
    let originalEnv;

    before(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      });
      Object.assign(process.env, originalEnv);
    });

    it("should auto-detect encrypted file source", async () => {
      const encryptedPath = path.join(testDir, "auto-detect.encrypted");
      const secrets = { PRIVATE_KEY: "0x" + "a".repeat(64) };
      encryptSecretsToFile(secrets, testPassword, encryptedPath);

      process.env.SECRETS_FILE = encryptedPath;
      process.env.SECRETS_PASSWORD = testPassword;

      const manager = await createSecretsManager();

      expect(manager.source).to.equal(SecretSource.ENCRYPTED_FILE);
      expect(manager.get("PRIVATE_KEY")).to.equal(secrets.PRIVATE_KEY);

      // Clean up
      delete process.env.SECRETS_FILE;
      delete process.env.SECRETS_PASSWORD;
    });

    it("should default to environment variables", async () => {
      // Clear any secret source environment variables
      delete process.env.SECRETS_FILE;
      delete process.env.SECRETS_PASSWORD;
      delete process.env.AWS_SECRET_NAME;
      delete process.env.AZURE_VAULT_URL;
      delete process.env.VAULT_ADDR;

      const manager = await createSecretsManager();

      expect(manager.source).to.equal(SecretSource.ENV);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Constants Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Constants", () => {
    it("should export required secrets configuration", () => {
      expect(REQUIRED_SECRETS).to.be.an("object");
      expect(REQUIRED_SECRETS.PRIVATE_KEY).to.have.property("description");
      expect(REQUIRED_SECRETS.PRIVATE_KEY).to.have.property("sensitive", true);
      expect(REQUIRED_SECRETS.PRIVATE_KEY).to.have.property("validator");
    });

    it("should export optional secrets configuration", () => {
      expect(OPTIONAL_SECRETS).to.be.an("object");
      expect(OPTIONAL_SECRETS.SLACK_WEBHOOK_URL).to.have.property("description");
    });

    it("should have validators for all secrets", () => {
      const allSecrets = { ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS };

      Object.entries(allSecrets).forEach(([key, config]) => {
        expect(config.validator, `${key} should have validator`).to.be.a("function");
      });
    });
  });
});
