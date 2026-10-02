const {bn,address}=require('./units');
const {checkSignal,abortable}=require('./asyncControl');
class QuoteEngine {
  constructor(adapters){this.adapters=adapters;this.cache=new Map();this.stats={requests:0,hits:0};}
  beginBlock(hash){if(this.blockHash!==hash){this.cache.clear();this.blockHash=hash;this.stats={requests:0,hits:0};}}
  async quoteLeg(leg,amount,blockTag,direction='input',signal){
    checkSignal(signal);
    const key=`${this.blockHash||blockTag}:${blockTag}:${leg.dex}:${leg.poolAddress}:${leg.tokenIn}:${leg.tokenOut}:${leg.feeTier}:${leg.router}:${leg.factory}:${leg.quoter}:${direction}:${amount}`;
    let promise=this.cache.get(key);
    if(promise)this.stats.hits++;
    else {this.stats.requests++;const adapter=this.adapters[leg.dex];promise=Promise.resolve().then(()=>direction==='output'?adapter.quoteExactOutput(leg,amount,blockTag):adapter.quoteExactInput(leg,amount,blockTag));this.cache.set(key,promise);promise.catch(()=>{if(this.cache.get(key)===promise)this.cache.delete(key);});}
    return abortable(promise,signal);
  }
  async quoteRoute(route,amount,blockTag,signal){
    let current=bn(amount),token=address(route.borrowToken);const quotes=[];
    if(![2,3].includes(route.legs?.length))throw new Error('Only two/three leg cycles supported');
    const pools=new Set();
    for(const leg of route.legs){
      if(address(leg.tokenIn)!==token||pools.has(leg.poolAddress))throw new Error('Invalid route continuity/pool reuse');
      pools.add(leg.poolAddress);const adapter=this.adapters[leg.dex];if(!adapter)throw new Error('Unsupported protocol');
      const amountOut=await this.quoteLeg(leg,current,blockTag,'input',signal);if(amountOut.lte(0))throw new Error('Empty executable quote');
      quotes.push({leg,amountIn:current,amountOut});current=amountOut;token=address(leg.tokenOut);
    }
    if(token!==address(route.borrowToken))throw new Error('Route is not a cycle');
    return {route,borrowAmount:bn(amount),expectedFinalAmount:current,quotes,stateBlock:blockTag,quotedAt:Date.now()};
  }
  buildData(quote,minProfit,slippageBps){return {borrowToken:quote.route.borrowToken,borrowAmount:quote.borrowAmount,steps:quote.quotes.map(q=>this.adapters[q.leg.dex].buildSwapStep(q.leg,q.amountOut,slippageBps)),minProfit:bn(minProfit),route:quote.quotes.map(q=>`${q.leg.tokenIn} > ${q.leg.dex}:${q.leg.poolAddress}`).join(' | ')};}
}
module.exports={QuoteEngine};
