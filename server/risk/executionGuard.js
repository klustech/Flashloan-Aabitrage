const {bn,address}=require('../bot/units');
function executionGuard({route,quote,economics,profile,head,now=Date.now(),signal}) {
  if(signal?.aborted){const e=new Error('Aborted');e.name='AbortError';throw e;}
  if(route.chainId!==profile.chainId||route.legs.length>profile.maxRouteHops)throw new Error('Route outside production scope');
  if(!economics.profitable)throw new Error('Net profit below minimum');
  if(bn(economics.estimatedGasUnits).gt(profile.maxGasUnits))throw new Error('Gas units exceed ceiling');
  if(quote.stateBlock!==head)throw new Error('Quote state is stale');
  if(now-quote.quotedAt>profile.maxQuoteAgeMs)throw new Error('Quote expired');
  for(const leg of route.legs){
    if(!leg.poolAddress||!leg.tokenIn||!leg.tokenOut||leg.stateBlock!==head||now-leg.stateTimestamp>profile.maxPoolStateAgeMs)throw new Error('Pool state missing/stale');
    if(!Number.isInteger(leg.tokenInDecimals)||!Number.isInteger(leg.tokenOutDecimals))throw new Error('Missing token decimals');
  }
  if(address(route.legs[0].tokenIn)!==address(route.borrowToken)||address(route.legs.at(-1).tokenOut)!==address(route.borrowToken))throw new Error('Invalid cycle');
  return true;
}
module.exports={executionGuard};
