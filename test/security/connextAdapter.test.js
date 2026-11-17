// ConnextAdapter: ownership handover, exact relayer fee, transfer id, rescue,
// and xReceive origin authentication.
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ConnextAdapter", function () {
  const DOMAIN = 1634886255;
  const ORIGIN_DOMAIN = 6648936;
  const AMOUNT = ethers.utils.parseUnits("250", 6);
  const FEE = ethers.utils.parseEther("0.01");
  let owner, other, newOwner, origin, token, connext, adapter, destination;

  beforeEach(async () => {
    [owner, other, newOwner, origin, destination] = await ethers.getSigners();
    token = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("USD Coin", "USDC", 6);
    connext = await (await ethers.getContractFactory("MockConnext")).deploy();
    adapter = await (
      await ethers.getContractFactory("ConnextAdapter")
    ).deploy(connext.address, DOMAIN, destination.address);
    await token.mint(owner.address, AMOUNT.mul(4));
    await token.connect(owner).approve(adapter.address, AMOUNT.mul(4));
  });

  describe("ownership", () => {
    it("hands over in two steps and only to the pending owner", async () => {
      await adapter.transferOwnership(newOwner.address);
      expect(await adapter.owner()).to.equal(owner.address);
      expect(await adapter.pendingOwner()).to.equal(newOwner.address);
      await expect(adapter.connect(other).acceptOwnership()).to.be.revertedWith(
        "ConnextAdapter: not pending owner"
      );
      await expect(adapter.connect(newOwner).acceptOwnership())
        .to.emit(adapter, "OwnershipTransferred")
        .withArgs(owner.address, newOwner.address);
      expect(await adapter.owner()).to.equal(newOwner.address);
      expect(await adapter.pendingOwner()).to.equal(
        ethers.constants.AddressZero
      );
    });

    it("rejects non-owners", async () => {
      await expect(
        adapter.connect(other).transferOwnership(other.address)
      ).to.be.revertedWith("ConnextAdapter: not owner");
      await expect(
        adapter
          .connect(other)
          .forwardArbitrage(token.address, AMOUNT, FEE, { value: FEE })
      ).to.be.revertedWith("ConnextAdapter: not owner");
      await expect(
        adapter.connect(other).rescueToken(token.address, other.address, 1)
      ).to.be.revertedWith("ConnextAdapter: not owner");
      await expect(
        adapter.connect(other).rescueNative(other.address, 1)
      ).to.be.revertedWith("ConnextAdapter: not owner");
    });
  });

  describe("forwardArbitrage", () => {
    it("forwards the amount, passes the exact fee and emits the transfer id", async () => {
      const id = await connext.TRANSFER_ID();
      await expect(
        adapter.forwardArbitrage(token.address, AMOUNT, FEE, { value: FEE })
      )
        .to.emit(adapter, "ArbitrageForwarded")
        .withArgs(token.address, AMOUNT, owner.address, id);
      expect(await token.balanceOf(connext.address)).to.equal(AMOUNT);
      expect(await connext.lastFee()).to.equal(FEE);
      expect(await connext.lastDestination()).to.equal(DOMAIN);
      expect(await connext.lastTo()).to.equal(destination.address);
      expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);
    });

    it("rejects overpaid or underpaid relayer fees and zero amounts", async () => {
      await expect(
        adapter.forwardArbitrage(token.address, AMOUNT, FEE, {
          value: FEE.add(1),
        })
      ).to.be.revertedWith("ConnextAdapter: fee mismatch");
      await expect(
        adapter.forwardArbitrage(token.address, AMOUNT, FEE, {
          value: FEE.sub(1),
        })
      ).to.be.revertedWith("ConnextAdapter: fee mismatch");
      await expect(
        adapter.forwardArbitrage(token.address, 0, FEE, { value: FEE })
      ).to.be.revertedWith("ConnextAdapter: zero amount");
    });
  });

  describe("rescue", () => {
    it("recovers tokens stranded in the adapter", async () => {
      await token.mint(adapter.address, AMOUNT);
      await expect(adapter.rescueToken(token.address, other.address, AMOUNT))
        .to.emit(adapter, "Rescued")
        .withArgs(token.address, other.address, AMOUNT);
      expect(await token.balanceOf(other.address)).to.equal(AMOUNT);
    });

    it("recovers native currency and rejects the zero address", async () => {
      // A contract without a payable fallback can still be force-funded; emulate
      // that with hardhat_setBalance.
      await ethers.provider.send("hardhat_setBalance", [
        adapter.address,
        ethers.utils.hexValue(FEE),
      ]);
      const before = await other.getBalance();
      await adapter.rescueNative(other.address, FEE);
      expect((await other.getBalance()).sub(before)).to.equal(FEE);
      await expect(
        adapter.rescueNative(ethers.constants.AddressZero, 1)
      ).to.be.revertedWith("ConnextAdapter: zero recipient");
      await expect(
        adapter.rescueToken(token.address, ethers.constants.AddressZero, 1)
      ).to.be.revertedWith("ConnextAdapter: zero recipient");
    });
  });

  describe("bot client (server/scripts/connextClient.js)", () => {
    it("matches the adapter ABI and scales thresholds by token decimals", async () => {
      const client = require("../../server/scripts/connextClient");
      const init = await client.initConnextClient({
        adapterAddress: adapter.address,
        provider: ethers.provider,
        signer: owner,
        config: {
          autoForwardEnabled: true,
          autoForwardThreshold: "1000",
          minForwardAmount: "10",
        },
      });
      expect(init.recipient).to.equal(destination.address);
      expect(await client.tokenDecimals(token.address)).to.equal(6);

      // Owner holds 1000 USDC (6 decimals): exactly at the whole-token threshold.
      const check = await client.checkAutoForward(token.address);
      expect(check.shouldForward).to.equal(true);
      expect(check.threshold).to.equal(ethers.utils.parseUnits("1000", 6));

      const below = await client.forwardProfits({
        token: token.address,
        amount: ethers.utils.parseUnits("9", 6),
        relayerFee: FEE,
      });
      expect(below.success).to.equal(false);

      const sent = await client.forwardProfits({
        token: token.address,
        amount: AMOUNT,
        relayerFee: FEE,
      });
      expect(sent.success, sent.error).to.equal(true);
      expect(sent.transferId).to.equal(await connext.TRANSFER_ID());
      expect(await token.balanceOf(connext.address)).to.equal(AMOUNT);
      expect(client.getPendingTransfers()[0].decimals).to.equal(6);
    });
  });

  describe("xReceive", () => {
    const payload = (addr) =>
      ethers.utils.defaultAbiCoder.encode(["address"], [addr]);

    beforeEach(async () => {
      await token.mint(connext.address, AMOUNT);
    });

    it("fails closed until a trusted origin is configured", async () => {
      await expect(
        connext.deliver(
          adapter.address,
          token.address,
          AMOUNT,
          origin.address,
          ORIGIN_DOMAIN,
          payload(other.address)
        )
      ).to.be.revertedWith("ConnextAdapter: origin not set");
    });

    it("pays the payload recipient only for the trusted sender and domain", async () => {
      await adapter.setTrustedOrigin(origin.address, ORIGIN_DOMAIN);
      await expect(
        connext.deliver(
          adapter.address,
          token.address,
          AMOUNT,
          other.address,
          ORIGIN_DOMAIN,
          payload(other.address)
        )
      ).to.be.revertedWith("ConnextAdapter: bad origin sender");
      await expect(
        connext.deliver(
          adapter.address,
          token.address,
          AMOUNT,
          origin.address,
          ORIGIN_DOMAIN + 1,
          payload(other.address)
        )
      ).to.be.revertedWith("ConnextAdapter: bad origin domain");
      await expect(
        connext.deliver(
          adapter.address,
          token.address,
          AMOUNT,
          origin.address,
          ORIGIN_DOMAIN,
          payload(other.address)
        )
      )
        .to.emit(adapter, "CrossChainReceived")
        .withArgs(token.address, AMOUNT, other.address);
      expect(await token.balanceOf(other.address)).to.equal(AMOUNT);
    });

    it("rejects calls that do not come from Connext", async () => {
      await adapter.setTrustedOrigin(origin.address, ORIGIN_DOMAIN);
      await expect(
        adapter.xReceive(
          ethers.constants.HashZero,
          1,
          token.address,
          origin.address,
          ORIGIN_DOMAIN,
          payload(other.address)
        )
      ).to.be.revertedWith("ConnextAdapter: only connext");
    });
  });
});
