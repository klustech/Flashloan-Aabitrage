const {bn}=require('./units');
const {findOptimalInput,v3VirtualReserves}=require('../scripts/ammMath');
const {checkSignal}=require('./asyncControl');
function sizingSeed(route,upper,premiumBps){
  const hops=route.legs.map(l=>{if(l.protocolVersion===2)return {reserveIn:l.reserveIn,reserveOut:l.reserveOut,feeBps:l.feeBps};const r=v3VirtualReserves(l.sqrtPriceX96,l.liquidity);const forward=l.tokenIn===l.token0;return {reserveIn:forward?r.reserve0:r.reserve1,reserveOut:forward?r.reserve1:r.reserve0,feeBps:l.feeBps};});
  return findOptimalInput({hops,maxInput:upper,premiumBps}).input;
}
async function sizeTrade({route,minInput,maxInput,premiumBps,evaluate,samples=10,refinements=5,signal}) {
  const lower=bn(minInput),upper=bn(maxInput);if(lower.lte(0)||upper.lt(lower))throw new Error('Invalid sizing bounds');
  const points=new Map(),cache=new Map();const add=x=>{const p=bn(x);if(p.gte(lower)&&p.lte(upper))points.set(p.toString(),p);};add(lower);add(upper);
  // Geometric sweep plus a reserve-math seed. V3 virtual reserves only seed the search.
  for(let i=1;i<samples;i++)add(upper.mul(i*i).div(samples*samples));
  try {add(sizingSeed(route,upper,premiumBps));}catch(_){/* exact search still runs */}
  let best=null;
  const probe=async x=>{checkSignal(signal);const key=x.toString();if(cache.has(key))return cache.get(key);let result=null;try{result=await evaluate(x);}catch(err){if(err.name==='AbortError')throw err;}checkSignal(signal);cache.set(key,result);if(result&&(!best||result.economics.expectedNetProfit.gt(best.economics.expectedNetProfit)))best=result;return result;};
  const sorted=[...points.values()].sort((a,b)=>a.lt(b)?-1:1);for(const p of sorted)await probe(p);
  if(!best)return null;
  const at=sorted.findIndex(p=>p.eq(best.quote.borrowAmount));let lo=sorted[Math.max(0,at-1)]||lower,hi=sorted[Math.min(sorted.length-1,at+1)]||upper;
  for(let i=0;i<refinements&&hi.sub(lo).gt(3);i++){const third=hi.sub(lo).div(3),a=lo.add(third),b=hi.sub(third);const ra=await probe(a),rb=await probe(b);if(ra&&(!rb||ra.economics.expectedNetProfit.gt(rb.economics.expectedNetProfit)))hi=b;else lo=a;}
  return best;
}
module.exports={sizeTrade,sizingSeed};
