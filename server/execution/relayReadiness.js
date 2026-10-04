// LIVE arming requires a stable, unfunded relay-auth identity. An ephemeral
// identity resets searcher reputation on every restart; a funded one means the
// auth key is being treated as a wallet, which it must never be.
async function relayIdentityChecks(relays,provider){
  const errors=[];
  if(!relays?.identity)return ['Private relay client unavailable'];
  const {address,persistent}=relays.identity();
  if(!persistent)errors.push('Persistent RELAY_AUTH_PRIVATE_KEY required');
  try{
    if(!(await provider.getBalance(address)).isZero())errors.push('Relay auth identity must hold no funds');
  }catch(_){errors.push('Relay auth identity balance unavailable');}
  return errors;
}
module.exports={relayIdentityChecks};
