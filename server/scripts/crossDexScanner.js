const { utils } = require('ethers');
function candidate(legs,block) {
  const key=legs.map(l=>`${l.chainId}:${l.dex}:${l.poolAddress}:${l.tokenIn}:${l.feeTier}`).join('|');
  return {id:utils.keccak256(utils.toUtf8Bytes(key)),strategy:legs.length===2?'CROSS_DEX_TWO_LEG':'TRIANGULAR_THREE_LEG',chain:'ethereum',chainId:legs[0].chainId,borrowToken:legs[0].tokenIn,legs,hops:legs,stateBlock:block,discoveredAt:Date.now()};
}
function scanTwoLeg(edges,borrowTokens,block) {
  const byInput=new Map(); for (const e of edges) {if(!byInput.has(e.tokenIn))byInput.set(e.tokenIn,[]);byInput.get(e.tokenIn).push(e);}
  const result=[];
  for(const borrow of borrowTokens) for(const first of byInput.get(borrow.toLowerCase())||[]) for(const second of byInput.get(first.tokenOut)||[]) {
    if(second.tokenOut===first.tokenIn && second.poolAddress!==first.poolAddress) result.push(candidate([first,second],block));
  }
  return result;
}
function scanTriangles(edges,borrowTokens,block) {
  const byInput=new Map(); for(const e of edges){if(!byInput.has(e.tokenIn))byInput.set(e.tokenIn,[]);byInput.get(e.tokenIn).push(e);}
  const result=[];
  for(const borrow of borrowTokens) for(const a of byInput.get(borrow.toLowerCase())||[]) for(const b of byInput.get(a.tokenOut)||[]) {
    if(b.tokenOut===a.tokenIn || b.poolAddress===a.poolAddress)continue;
    for(const c of byInput.get(b.tokenOut)||[]) if(c.tokenOut===a.tokenIn && ![a.poolAddress,b.poolAddress].includes(c.poolAddress))result.push(candidate([a,b,c],block));
  }
  return result;
}
module.exports={scanTwoLeg,scanTriangles,candidate};
