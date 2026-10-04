const { Contract, utils } = require("ethers");
const { HistoricalReplay,verifyReceipts } = require("../server/backrun/historicalReplay");
const { HistoricalBenchmark } = require("../server/backrun/benchmark");
const { BackrunEngine } = require("../server/backrun/backrunEngine");
const { BackrunTransactionBuilder } = require("../server/backrun/backrunTransactionBuilder");
const { SWAP_TOPICS } = require("../server/backrun/triggerDecoder");
const { bn, address } = require("../server/bot/units");
const { environment, topologyContext, save } = require("./backrun-context");
async function main() {
  const { profile, archive, backend } = environment(), start = Number(process.env.BACKRUN_START_BLOCK), end = Number(process.env.BACKRUN_END_BLOCK);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error("Explicit historical block range required");
  const report = new HistoricalBenchmark(profile), replay = new HistoricalReplay({ archive, backend });
  const first = await archive.getBlock(start), last = await archive.getBlock(end);
  const contract = new Contract(profile.contractAddress, require("../server/abis/ArbitrageFlashloan.json"), backend.provider);
  let evaluated = 0, tracked = 0,failedExactEvaluations=0;
  const proofs={};
  for (let number = start; number <= end; number++) {
    const data = await replay.block(number); report.blocks.add(number); report.stats.transactionsExamined += data.raw.length;
    const canonical = await topologyContext(profile, archive, data.parent.number), known = new Set(canonical.registry.values().map(p=>p.poolAddress));
    for (let index = 0; index < data.receipts.length; index++) {
      const receipt = data.receipts[index], affected = new Set(receipt.logs.filter(l=>known.has(address(l.address)) &&
        SWAP_TOPICS.has(l.topics[0]?.toLowerCase())).map(l=>address(l.address)));
      if (!affected.size || receipt.status !== 1) continue;
      tracked++; evaluated++; report.stats.decodedTriggers++; report.stats.affectedPools += affected.size;
      const started = Date.now(), trigger = { hash: receipt.transactionHash, rawTx: data.raw[index], source:"historical", receivedAt:Date.now() };
      try {
        await replay.prefix(data, index, async ({ provider, block }) => {
          // Prefix is already canonical post-trigger state; retain it through
          // quote/sizing and evaluate the unsigned executor on that same fork.
          const post = await topologyContext(profile, provider, block.number);
          const predictor = { withContext: async (_args, work) => {
            const id = utils.keccak256(utils.toUtf8Bytes(block.hash + trigger.hash));
            const overlay = new (require("../server/market/poolRegistry").PoolRegistry)(post.tokens);
            for (const p of post.registry.values()) overlay.add({...p,stateBlock:data.parent.number,stateTimestamp:Date.now(),predictionContext:id});
            const quoter = new (require("../server/bot/quoteEngine").QuoteEngine)(post.adapters); quoter.beginBlock(id);
            return work({id,active:true,provider,registry:overlay,quoter,parentBlock:data.parent.number,parentHash:data.parent.hash,
              triggerHash:trigger.hash,simulationBlock:block.number,changedPools:affected,predictionMs:Date.now()-started,
              assertActive(){},header:data.block});
          } };
          const builder = new BackrunTransactionBuilder({contract,tokens:post.tokens,profile,operatorAddress:profile.operatorAddress});
          const engine = new BackrunEngine({profile,tokens:post.tokens,contract,predictor,builder,maxCandidates:profile.backrun.maxCandidates});
          await engine.inspect({trigger,registry:canonical.registry,block:data.parent}, async ({opportunities}) => {
            report.stats.candidateRoutes += engine.stats.routes;
            if (!opportunities.length) { report.reject("no_viable_exact_route"); return; }
            const best = opportunities[0], measured={};
            for(const option of [best,...best.alternatePrepared]){
              if(Object.keys(measured).length){await backend.reset(data.parent);await backend.mine(data.raw.slice(0,index+1),data.block);}
              const transaction=option.transaction;
              const token=new Contract(option.route.borrowToken,["function balanceOf(address) view returns(uint256)"],provider);
              const principal=await token.balanceOf(contract.address,{blockTag:data.block.number});
              // Rebuild the prefix and append the unsigned executor in the
              // SAME historical block, preserving ordering and header.
              const sim=await backend.simulateUnsignedPrefix({rawTransactions:data.raw.slice(0,index+1),
                parent:data.parent,header:data.block,transaction});
              verifyReceipts(sim.prefixReceipts,data.receipts.slice(0,index+1));
              const execution=sim.backrunReceipt;
              const profit = execution.logs.filter(l=>address(l.address)===address(contract.address)).map(l=>{
                try{return contract.interface.parseLog(l);}catch(_){return null;}
              }).filter(l=>l?.name==="ProfitWithdrawn"&&address(l.args.token)===option.route.borrowToken&&address(l.args.recipient)===address(profile.expectedProfitRecipient))
                .reduce((s,l)=>s.add(l.args.amount),bn(0));
              if(profit.lt(option.economics.minimumRequiredProfit.add(option.costBudgetBorrow)))throw new Error("Historical settlement below floor");
              if(!(await token.balanceOf(contract.address)).eq(principal))throw new Error("Historical executor principal mismatch");
              measured[option.funding.mode]={net:option.economics.expectedNetProfit,gasUsed:execution.gasUsed,profit};
              proofs[option.funding.mode]??={profileFingerprint:require("../server/backrun/readiness").evidenceFingerprint(profile),
                passed:true,mode:option.funding.mode,executorVersion:3,blockNumber:number,parentHash:data.parent.hash,
                triggerHash:trigger.hash,txHash:execution.transactionHash,principalPreserved:true,
                canonicalReceiptsVerified:true,unsigned:true,gasUsed:execution.gasUsed.toString(),profit:profit.toString()};
            }
              report.record({triggerHash:trigger.hash,blockNumber:number,transactionIndex:index,canonicalReplayVerified:true,
                orderedSimulation:true,simulationMethod:"canonical prefix + unsigned executor in the same historical block",
                symbol:post.tokens.get(best.route.borrowToken).symbol,amount:best.quote.borrowAmount,fundingMode:best.funding.mode,
                grossProfit:best.grossProfit,capitalNet:measured.CAPITAL?.net||bn(0),flashNet:measured.FLASH_LOAN?.net||bn(0),
                capitalViable:Boolean(measured.CAPITAL),flashViable:Boolean(measured.FLASH_LOAN),netNative:best.netNative,
                fundingComparison:measured,
                gasNative:best.economics.estimatedGasCostNative,builderNative:best.tip.builderPaymentNativeWei,
                dexPair:best.route.legs.map(l=>l.dex).join(" → "),hops:best.route.legs.length,latencyMs:Date.now()-started});
          });
        });
      } catch (_) {failedExactEvaluations++; report.reject("canonical_replay_or_executor_unavailable");}
    }
    console.log("Historical block "+number+" complete");
  }
  const result=report.report({startBlock:start,endBlock:end,startedTimestamp:first.timestamp,endedTimestamp:last.timestamp,
    complete:failedExactEvaluations===0,evaluatedTriggers:evaluated,totalTrackedTriggers:tracked});
  result.fullExecutorSimulations=result.fullExecutorSimulations>0;
  result.sameBlockBundleVerified=result.fullExecutorSimulations;
  result.failedExactEvaluations=failedExactEvaluations;
  save(profile.backrun.benchmarkPath,result);
  for(const [mode,proof] of Object.entries(proofs))save(mode==="CAPITAL"?
    process.env.BACKRUN_CAPITAL_FORK_PROOF_PATH||"runtime/backrun/capital-fork-proof.json":
    process.env.BACKRUN_FLASH_FORK_PROOF_PATH||"runtime/backrun/flash-fork-proof.json",proof);
  if(process.env.NODE_ENV==="production"){const db=require("../server/dbClient");await db.insertBackrunBenchmark(result);await db.pool?.end();}
  console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error("Benchmark failed; no economic acceptance evidence issued.");process.exitCode=1;});
module.exports={main};
