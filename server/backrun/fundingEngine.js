const { bn, address } = require("../bot/units");

class FundingEngine {
  constructor({ provider, contract, tokens, flashloan, profile }) {
    Object.assign(this, { provider, contract, tokens, flashloan, profile });
  }

  tokenPolicy(token) {
    const symbol=this.tokens.get(address(token)).symbol;
    const minimum=this.profile.backrun?.minimumProfitBySymbol?.[symbol];
    const maximum=this.profile.backrun?.maxAmountBySymbol?.[symbol];
    if(!minimum||!maximum)throw new Error(`Missing backrun risk limits for ${symbol}`);
    return {
      symbol,
      minimum:this.tokens.parse(token,minimum),
      maximum:this.tokens.parse(token,maximum),
    };
  }

  async capitalAvailable(token, blockTag) {
    const erc20 = new (require("ethers").Contract)(
      address(token),
      ["function balanceOf(address) view returns(uint256)"],
      this.provider
    );
    const balance = bn(await erc20.balanceOf(this.contract.address, { blockTag }));
    const reserveBps = Number(this.profile.backrun?.capitalReserveBps ?? 0);
    return balance.mul(10000 - reserveBps).div(10000);
  }

  async decide({
    token,
    amount,
    grossProfit,
    gasCostBorrowToken = 0,
    builderPaymentBorrowToken = 0,
    terms,
    blockTag,
  }) {
    token = address(token);
    amount = bn(amount);
    grossProfit = bn(grossProfit);
    if (amount.lte(0) || bn(gasCostBorrowToken).lt(0) || bn(builderPaymentBorrowToken).lt(0))
      throw new Error("Invalid backrun amount/cost");
    const variableCost = bn(gasCostBorrowToken).add(builderPaymentBorrowToken);
    const policy=this.tokenPolicy(token),minimum=policy.minimum;
    const mode = this.profile.backrun?.fundingMode || "adaptive";
    if(amount.gt(policy.maximum))return {
      mode:"REJECT",
      reason:"amount_exceeds_backrun_limit",
      maximum:policy.maximum,
      symbol:policy.symbol,
    };

    const capital = await this.capitalAvailable(token, blockTag);
    const capitalCostCovered = grossProfit.gte(variableCost);
    const capitalNet = capitalCostCovered ? grossProfit.sub(variableCost) : bn(0);
    const capitalViable =
      capitalCostCovered && capital.gte(amount) && capitalNet.gte(minimum);

    const premiumBps = Number(terms?.premiumBps);
    const validTerms = terms?.premiumBps !== null && terms?.premiumBps !== undefined &&
      Number.isInteger(premiumBps) && premiumBps >= 0 && premiumBps < 10000;
    const flashFee = validTerms ? this.flashloan.fee(amount, premiumBps) : bn(0);
    const flashCost = variableCost.add(flashFee);
    const flashCostCovered = validTerms && grossProfit.gte(flashCost);
    const flashNet = flashCostCovered ? grossProfit.sub(flashCost) : bn(0);
    const flashViable =
      flashCostCovered && bn(terms?.availableLiquidity ?? 0).gte(amount) &&
      flashNet.gte(minimum);

    if ((mode === "adaptive" || mode === "capital") && capitalViable) {
      return {
        mode: "CAPITAL",
        fundingCost: bn(0),
        expectedNetProfit: capitalNet,
        capitalAvailable: capital,
        flashFee,
        capitalNet,
        flashNet,
        capitalCostCovered,
        flashCostCovered,
        protectedReserveBps: this.profile.backrun.capitalReserveBps,
        capitalViable, flashViable,
      };
    }
    if ((mode === "adaptive" || mode === "flashloan") && flashViable) {
      return {
        mode: "FLASH_LOAN",
        fundingCost: flashFee,
        expectedNetProfit: flashNet,
        capitalAvailable: capital,
        flashFee,
        capitalNet,
        flashNet,
        capitalCostCovered,
        flashCostCovered,
        protectedReserveBps: this.profile.backrun.capitalReserveBps,
        capitalViable, flashViable,
      };
    }

    return {
      mode: "REJECT",
      reason:
        mode === "capital"
          ? "insufficient_capital_or_net_profit"
          : mode === "flashloan"
            ? "flashloan_fee_or_liquidity_eliminates_profit"
            : "no_economically_viable_funding_source",
      capitalAvailable: capital,
      flashFee,
      capitalNet,
      flashNet,
      capitalCostCovered,
      flashCostCovered,
    };
  }
}

module.exports = { FundingEngine };
