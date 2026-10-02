const {bn,address}=require('./units');
class QuoteEngine {
  constructor(adapters){this.adapters=adapters;}
  async quoteRoute(route,amount,blockTag){
    let current=bn(amount),token=address(route.borrowToken);const quotes=[];
    if(![2,3].includes(route.legs?.length))throw new Error('Only two/three leg cycles supported');
    const pools=new Set();
    for(const leg of route.legs){
      if(address(leg.tokenIn)!==token||pools.has(leg.poolAddress))throw new Error('Invalid route continuity/pool reuse');
      pools.add(leg.poolAddress);const adapter=this.adapters[leg.dex];if(!adapter)throw new Error('Unsupported protocol');
      const amountOut=await adapter.quoteExactInput(leg,current,blockTag);if(amountOut.lte(0))throw new Error('Empty executable quote');
      quotes.push({leg,amountIn:current,amountOut});current=amountOut;token=address(leg.tokenOut);
    }
    if(token!==address(route.borrowToken))throw new Error('Route is not a cycle');
    return {route,borrowAmount:bn(amount),expectedFinalAmount:current,quotes,stateBlock:blockTag,quotedAt:Date.now()};
  }
  buildData(quote,minProfit,slippageBps){return {borrowToken:quote.route.borrowToken,borrowAmount:quote.borrowAmount,steps:quote.quotes.map(q=>this.adapters[q.leg.dex].buildSwapStep(q.leg,q.amountOut,slippageBps)),minProfit:bn(minProfit),route:quote.quotes.map(q=>`${q.leg.tokenIn} > ${q.leg.dex}:${q.leg.poolAddress}`).join(' | ')};}
}
module.exports={QuoteEngine};
