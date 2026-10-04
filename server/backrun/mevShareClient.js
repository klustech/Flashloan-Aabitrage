const { Wallet, utils } = require("ethers");

function blockHex(value) {
  return utils.hexValue(Number(value));
}

class MevShareClient {
  constructor({
    apiUrl = "https://relay.flashbots.net",
    authKey,
    authSigner,
    timeoutMs = 3000,
    builders = ["default"],
  } = {}) {
    this.apiUrl = String(apiUrl).replace(/\/$/, "");
    this.authConfigured = Boolean(authSigner || authKey);
    this.authSigner = authSigner || (authKey ? new Wallet(authKey) : Wallet.createRandom());
    this.timeoutMs = timeoutMs;
    this.builders = builders;
    this.stats = { simulations: 0, submissions: 0, errors: 0 };
  }

  buildBundle({
    triggerHash,
    triggerRawTx,
    signedBackrun,
    targetBlock,
    maxBlock = targetBlock,
  }) {
    if (!signedBackrun || !String(signedBackrun).startsWith("0x")) {
      throw new Error("Signed backrun transaction required");
    }
    if (!triggerHash && !triggerRawTx) {
      throw new Error("Trigger hash or raw transaction required");
    }
    const trigger = triggerRawTx
      ? { tx: triggerRawTx, canRevert: false }
      : { hash: triggerHash };
    return {
      version: "v0.1",
      inclusion: {
        block: blockHex(targetBlock),
        maxBlock: blockHex(maxBlock),
      },
      body: [
        trigger,
        { tx: signedBackrun, canRevert: false },
      ],
      validity: { refund: [], refundConfig: [] },
      privacy: { builders: this.builders },
    };
  }

  async request(method, params) {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    });
    const signature = await this.authSigner.signMessage(utils.id(payload));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-flashbots-signature": this.authSigner.address + ":" + signature,
        },
        body: payload,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.error) {
        const message = body?.error?.message || ("HTTP " + response.status);
        throw new Error(method + " failed: " + message);
      }
      return body.result;
    } catch (err) {
      this.stats.errors++;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async simulate(bundle, { parentBlock, targetBlock } = {}) {
    this.stats.simulations++;
    const options = {};
    if (parentBlock !== undefined) options.parentBlock = blockHex(parentBlock);
    if (targetBlock !== undefined) options.blockNumber = Number(targetBlock);
    const result = await this.request("mev_simBundle", [bundle, options]);
    if (!result?.success) {
      throw new Error("MEV-Share bundle simulation failed" + (result?.error ? ": " + result.error : ""));
    }
    return result;
  }

  async send(bundle) {
    if (!this.authConfigured) {
      throw new Error("FLASHBOTS_AUTH_KEY required for MEV-Share submission");
    }
    this.stats.submissions++;
    const result = await this.request("mev_sendBundle", [bundle]);
    if (!result?.bundleHash) throw new Error("MEV-Share submission missing bundle hash");
    return result;
  }

  status() {
    return {
      apiUrl: this.apiUrl,
      authConfigured: this.authConfigured,
      ...this.stats,
    };
  }
}

module.exports = { MevShareClient, blockHex };
