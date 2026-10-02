const {bn}=require('./units');
const {scanTwoLeg,scanTriangles}=require('../scripts/crossDexScanner');
function marginalRate(leg){
  let numerator,denominator;
  if(leg.protocolVersion===2){numerator=bn(leg.reserveOut);denominator=bn(leg.reserveIn);}
  else {const squared=bn(leg.sqrtPriceX96).pow(2),q192=bn(2).pow(192);[numerator,denominator]=leg.tokenIn===leg.token0?[squared,q192]:[q192,squared];}
  const feeMillion=leg.protocolVersion===3?leg.feeTier:leg.feeBps*100;
  return {numerator:numerator.mul(1000000-feeMillion),denominator:denominator.mul(1000000)};
}
function discoverCandidates(registry,borrowTokens,block){
  const edges=registry.edges(),routes=[...scanTwoLeg(edges,borrowTokens,block),...scanTriangles(edges,borrowTokens,block)];
  return routes.map(route=>{let n=bn(1),d=bn(1);for(const leg of route.legs){const r=marginalRate(leg);n=n.mul(r.numerator);d=d.mul(r.denominator);}return {...route,spreadPpm:n.mul(1000000).div(d).sub(1000000)};})
    .filter(r=>r.spreadPpm.gt(0)).sort((a,b)=>a.spreadPpm.gt(b.spreadPpm)?-1:1);
}
function priceMovementBps(oldLeg,newLeg){const a=marginalRate(oldLeg),b=marginalRate(newLeg);const old=a.numerator.mul(b.denominator),next=b.numerator.mul(a.denominator);return next.sub(old).abs().mul(10000).div(old);}
module.exports={discoverCandidates,marginalRate,priceMovementBps};
