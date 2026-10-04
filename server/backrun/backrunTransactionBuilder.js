const { utils } = require("ethers");
const { bn } = require("../bot/units");
const { buildExecutorTransaction } = require("./executorTransaction");
const { builderTip } = require("../execution/builderTip");
const {safeReason}=require("./errors");
class BackrunTransactionBuilder {
  constructor({ contract, tokens, profile, operatorAddress }) {
    Object.assign(this, { contract, tokens, profile, operatorAddress });
  }
  minimum(token) { return this.tokens.parse(token, this.profile.backrun.minimumProfitBySymbol[this.tokens.get(token).symbol]); }
  async prepareAdaptive(candidate,context,postQuoter,signal){
    const modes=this.profile.backrun.fundingMode==="adaptive"?["CAPITAL","FLASH_LOAN"]:
      [this.profile.backrun.fundingMode==="capital"?"CAPITAL":"FLASH_LOAN"];
    const prepared=[],comparisons={};
    for(const mode of modes){
      const available=mode==="CAPITAL"?candidate.funding.capitalAvailable:candidate.flashloanTerms.availableLiquidity;
      if(bn(available).lt(candidate.quote.borrowAmount)){comparisons[mode]={viable:false,reason:"insufficient_funding"};continue;}
      const cost=mode==="CAPITAL"?bn(0):candidate.funding.flashFee;
      try{
        const result=await this.prepare({...candidate,funding:{...candidate.funding,mode,fundingCost:cost}},context,postQuoter,signal);
        comparisons[mode]={viable:true,expectedNetProfit:result.economics.expectedNetProfit,gasLimit:result.transaction.gasLimit};
        prepared.push(result);
      }catch(e){if(e.name==="AbortError")throw e;comparisons[mode]={viable:false,reason:safeReason(e)};}
    }
    if(!prepared.length)throw new Error("No measured funding path is viable");
    return {...prepared[0],fundingComparisons:comparisons,alternatePrepared:prepared.slice(1)};
  }
  async prepare(candidate, context, postQuoter, signal) {
    context.assertActive();
    const quote = candidate.quote, mode = candidate.funding.mode;
    const minimum = this.minimum(quote.route.borrowToken);
    const rawProfit = candidate.grossProfit.sub(candidate.funding.fundingCost);
    const nativeProfit = await postQuoter.toNative(quote.route.borrowToken, rawProfit, signal);
    let gasLimit = bn(this.profile.maxGasUnits);
    const tipFor = gas => builderTip({ profitNativeWei: nativeProfit,
      baseFeePerGas: candidate.block.baseFeePerGas, gasLimit: gas,
      maxBuilderShareBps: this.profile.maxBuilderShareBps, maxPriorityFeePerGas: utils.parseUnits("5", "gwei") });
    let tip = tipFor(gasLimit);
    const build = (minProfit, gas, fees) => buildExecutorTransaction({
      contract: this.contract, from: this.operatorAddress, fundingMode: mode,
      data: context.quoter.buildData(quote, minProfit, this.profile.slippageBps),
      gasLimit: gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    const provisional = build(minimum, gasLimit, tip);
    // Both operations run on the fork AFTER the trigger, never the parent RPC.
    await context.provider.call(provisional, context.simulationBlock);
    context.assertActive();
    const estimate = await context.provider.estimateGas(provisional);
    gasLimit = bn(estimate).mul(120).add(99).div(100);
    if (gasLimit.gt(this.profile.maxGasUnits)) throw new Error("Backrun gas exceeds ceiling");
    tip = tipFor(gasLimit);
    if (tip.maxFeePerGas.gt(utils.parseUnits(this.profile.gasCeilingGwei, "gwei"))) throw new Error("Backrun gas price exceeds ceiling");
    const nativeCost = gasLimit.mul(tip.maxFeePerGas);
    const cost = await postQuoter.nativeCost(quote.route.borrowToken, nativeCost, signal);
    const expectedNetProfit = candidate.grossProfit.sub(candidate.funding.fundingCost).sub(cost);
    if (expectedNetProfit.lt(minimum)) throw new Error("Measured backrun net below minimum");
    const transaction = build(minimum.add(cost), gasLimit, tip);
    await context.provider.call(transaction, context.simulationBlock); context.assertActive();
    return { ...candidate, transaction, tip, contextId: context.id, preparedAt: Date.now(),
      // Budget signed gas-limit * maxFee, including priority only once.
      economics: { profitable: true, expectedGrossProfit: candidate.grossProfit,
        flashloanFee: candidate.funding.fundingCost, estimatedGasUnits: gasLimit,
        estimatedGasCostNative: nativeCost, estimatedGasCostBorrowToken: cost,
        minimumRequiredProfit: minimum, expectedNetProfit, gasEstimation: "post_trigger_executor_estimate" },
      funding: { ...candidate.funding, expectedNetProfit,
        capitalNet:candidate.grossProfit.sub(cost),
        flashNet:candidate.grossProfit.sub(cost).sub(candidate.funding.flashFee),
        capitalViable:bn(candidate.funding.capitalAvailable).gte(quote.borrowAmount)&&candidate.grossProfit.sub(cost).gte(minimum),
        flashViable:bn(candidate.flashloanTerms.availableLiquidity).gte(quote.borrowAmount)&&candidate.grossProfit.sub(cost).sub(candidate.funding.flashFee).gte(minimum)
      }, costBudgetBorrow: cost };
  }
}
module.exports = { BackrunTransactionBuilder };
