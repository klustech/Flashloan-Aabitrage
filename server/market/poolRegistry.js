const { address, integer } = require('../bot/units');
function canonicalPool(pool,tokens) {
  const token0=tokens.get(pool.token0),token1=tokens.get(pool.token1);
  const version=pool.dex.endsWith('_v3')?3:2;
  if (token0.address===token1.address) throw new Error('Identical pool tokens');
  return Object.freeze({...pool,chainId:tokens.chainId,poolAddress:address(pool.poolAddress || pool.pairAddress),token0:token0.address,token1:token1.address,
    token0Decimals:token0.decimals,token1Decimals:token1.decimals,protocolVersion:version,
    feeTier:version===3?integer(pool.feeTier ?? pool.fee,'fee tier',1,100000):0,
    feeBps:version===3?Number(pool.feeTier ?? pool.fee)/100:integer(pool.feeBps ?? 30,'fee bps',0,9999),
    quoteMethod:version===3?'quoter':'getAmountsOut'});
}
function edge(pool,tokenIn) {
  const input=address(tokenIn); if (![pool.token0,pool.token1].includes(input)) throw new Error('Token outside pool');
  const forward=input===pool.token0;
  return {...pool,tokenIn:input,tokenOut:forward?pool.token1:pool.token0,tokenInDecimals:forward?pool.token0Decimals:pool.token1Decimals,tokenOutDecimals:forward?pool.token1Decimals:pool.token0Decimals,
    tokenA:input,tokenB:forward?pool.token1:pool.token0,reserveIn:forward?pool.reserve0:pool.reserve1,reserveOut:forward?pool.reserve1:pool.reserve0};
}
class PoolRegistry {
  constructor(tokens) {this.tokens=tokens;this.pools=new Map();}
  add(pool) { const p=canonicalPool(pool,this.tokens);this.pools.set(`${p.chainId}:${p.dex}:${p.poolAddress}`,p);return p; }
  values() {return [...this.pools.values()];}
  edges() {return this.values().flatMap(p=>[edge(p,p.token0),edge(p,p.token1)]);}
}
module.exports={PoolRegistry,canonicalPool,edge};
