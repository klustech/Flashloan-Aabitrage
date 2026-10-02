const {bn}=require('./units');
const {scanTwoLeg,scanTriangles}=require('../scripts/crossDexScanner');
const {edge}=require('../market/poolRegistry');
function marginalRate(leg){
  let numerator,denominator;
  if(leg.protocolVersion===2){numerator=bn(leg.reserveOut);denominator=bn(leg.reserveIn);}
  else {const squared=bn(leg.sqrtPriceX96).pow(2),q192=bn(2).pow(192);[numerator,denominator]=leg.tokenIn===leg.token0?[squared,q192]:[q192,squared];}
  const feeMillion=leg.protocolVersion===3?leg.feeTier:leg.feeBps*100;
  return {numerator:numerator.mul(1000000-feeMillion),denominator:denominator.mul(1000000)};
}
function discoverCandidates(registry,borrowTokens,block){
  const edges=registry.edges().filter(l=>l.protocolVersion===2?bn(l.reserveIn).gt(0)&&bn(l.reserveOut).gt(0):bn(l.liquidity).gt(0)&&bn(l.sqrtPriceX96).gt(0)),routes=[...scanTwoLeg(edges,borrowTokens,block),...scanTriangles(edges,borrowTokens,block)];
  return routes.map(route=>{let n=bn(1),d=bn(1);for(const leg of route.legs){const r=marginalRate(leg);n=n.mul(r.numerator);d=d.mul(r.denominator);}return {...route,spreadPpm:n.mul(1000000).div(d).sub(1000000)};})
    .filter(r=>r.spreadPpm.gt(0)).sort((a,b)=>a.spreadPpm.gt(b.spreadPpm)?-1:1);
}
function priceMovementBps(oldLeg,newLeg){const a=marginalRate(oldLeg),b=marginalRate(newLeg);const old=a.numerator.mul(b.denominator),next=b.numerator.mul(a.denominator);return next.sub(old).abs().mul(10000).div(old);}
class CandidateIndex {
  constructor(){this.routes=new Map();this.byPool=new Map();this.scores=new Map();this.stats={rebuilds:0,repriced:0};}
  candidates(registry,borrowTokens,block,changedPools,limit){
    const pools=registry.values(),byAddress=new Map(pools.map(p=>[`${p.dex}:${p.poolAddress}`,p]));
    const topology=JSON.stringify([borrowTokens,[...pools.map(p=>`${p.dex}:${p.poolAddress}:${p.token0}:${p.token1}:${p.feeTier}`)].sort()]);
    let affected=new Set();
    if(topology!==this.topology){
      this.topology=topology;this.routes.clear();this.byPool.clear();this.scores.clear();this.stats.rebuilds++;
      const edges=registry.edges();
      for(const route of [...scanTwoLeg(edges,borrowTokens,block),...scanTriangles(edges,borrowTokens,block)]){
        this.routes.set(route.id,route);affected.add(route.id);
        for(const leg of route.legs){if(!this.byPool.has(leg.poolAddress))this.byPool.set(leg.poolAddress,new Set());this.byPool.get(leg.poolAddress).add(route.id);}
      }
    }else for(const pool of changedPools||[])for(const id of this.byPool.get(pool)||[])affected.add(id);
    const materialize=route=>{const legs=route.legs.map(l=>edge(byAddress.get(`${l.dex}:${l.poolAddress}`),l.tokenIn));return {...route,legs,hops:legs,stateBlock:block,spreadPpm:this.scores.get(route.id)};};
    for(const id of affected){
      const route=materialize(this.routes.get(id));let n=bn(1),d=bn(1),liquid=true;
      for(const leg of route.legs){if(leg.protocolVersion===2?bn(leg.reserveIn).lte(0)||bn(leg.reserveOut).lte(0):bn(leg.liquidity).lte(0)||bn(leg.sqrtPriceX96).lte(0)){liquid=false;break;}const r=marginalRate(leg);n=n.mul(r.numerator);d=d.mul(r.denominator);}
      this.scores.set(id,liquid?n.mul(1000000).div(d).sub(1000000):bn(0));
    }
    this.stats.repriced=affected.size;this.stats.indexed=this.routes.size;
    const ranked=[...this.routes.values()].filter(r=>this.scores.get(r.id)?.gt(0)).sort((a,b)=>this.scores.get(a.id).gt(this.scores.get(b.id))?-1:1);
    this.stats.profitableMarginal=ranked.length;
    return ranked.slice(0,limit??ranked.length).map(materialize);
  }
}
module.exports={discoverCandidates,marginalRate,priceMovementBps,CandidateIndex};
