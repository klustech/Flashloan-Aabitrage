const test=require('node:test');
const assert=require('node:assert/strict');
const {Wallet,BigNumber}=require('ethers');
const {PrivateRelays,resolveRelayAuthSigner}=require('../../server/execution/privateRelays');
const {relayIdentityChecks}=require('../../server/execution/relayReadiness');

const auth=Wallet.createRandom(),exec=Wallet.createRandom();
const tx='0x02';

test('configured relay auth key gives a persistent identity independent of PRIVATE_KEY',()=>{
  const env={RELAY_AUTH_PRIVATE_KEY:auth.privateKey,PRIVATE_KEY:exec.privateKey};
  const a=new PrivateRelays(null,['https://r1'],undefined,{env}),b=new PrivateRelays(null,['https://r1'],undefined,{env});
  assert.deepEqual(a.identity(),{address:auth.address,persistent:true});
  assert.equal(b.identity().address,a.identity().address);
  assert.equal(JSON.stringify(a.status()).includes(auth.privateKey.slice(2)),false);
});

test('legacy FLASHBOTS_AUTH_KEY alias is honoured',()=>{
  assert.equal(resolveRelayAuthSigner({env:{FLASHBOTS_AUTH_KEY:auth.privateKey}}).signer.address,auth.address);
});

test('missing relay auth key falls back to an ephemeral, non-persistent identity',()=>{
  const a=new PrivateRelays(null,[],undefined,{env:{}}),b=new PrivateRelays(null,[],undefined,{env:{}});
  assert.equal(a.identity().persistent,false);
  assert.notEqual(a.identity().address,b.identity().address);
});

test('relay auth key equal to the execution signer is refused',()=>{
  assert.throws(()=>new PrivateRelays(null,[],undefined,{env:{RELAY_AUTH_PRIVATE_KEY:exec.privateKey,PRIVATE_KEY:exec.privateKey}}),/must differ/);
  assert.throws(()=>new PrivateRelays(null,[],exec.privateKey,{env:{},executionAddress:exec.address}),/must differ/);
});

test('readiness requires a persistent, unfunded relay identity',async()=>{
  const env={RELAY_AUTH_PRIVATE_KEY:auth.privateKey};
  const zero={getBalance:async()=>BigNumber.from(0)},funded={getBalance:async()=>BigNumber.from(1)};
  assert.deepEqual(await relayIdentityChecks(new PrivateRelays(null,[],undefined,{env}),zero),[]);
  assert.deepEqual(await relayIdentityChecks(new PrivateRelays(null,[],undefined,{env}),funded),['Relay auth identity must hold no funds']);
  assert.deepEqual(await relayIdentityChecks(new PrivateRelays(null,[],undefined,{env:{}}),zero),['Persistent RELAY_AUTH_PRIVATE_KEY required']);
  assert.deepEqual(await relayIdentityChecks(new PrivateRelays(null,[],undefined,{env}),{getBalance:async()=>{throw new Error('rpc');}}),['Relay auth identity balance unavailable']);
});

test('per-relay telemetry tracks simulation, validation, submission and outcome',async()=>{
  const relays=new PrivateRelays(null,['https://good','https://bad','https://down'],undefined,{env:{RELAY_AUTH_PRIVATE_KEY:auth.privateKey}});
  const fakes={
    'https://good':{simulate:async()=>({results:[]}),sendRawBundle:async()=>({bundleHash:'0xaa'})},
    'https://bad':{simulate:async()=>({error:{message:'bad sim'}}),sendRawBundle:async()=>({error:{message:'rejected'}})},
    'https://down':{simulate:async()=>{throw new Error('ECONNREFUSED');}}};
  relays.get=async url=>fakes[url];
  const sims=await relays.simulate([tx,tx],2,1);
  assert.deepEqual(sims.map(s=>s.url),['https://good','https://bad']);
  relays.recordValidation('https://good',true);relays.recordValidation('https://bad',false);
  const submissions=await relays.submit(sims,[tx,tx],2,async()=>{});
  assert.deepEqual(submissions,[{url:'https://good',bundleHash:'0xaa'}]);
  relays.recordOutcome(submissions,'INCLUDED');relays.recordOutcome(submissions,'PENDING');
  const s=relays.status().relays;
  assert.equal(s['https://good'].simulations,1);assert.equal(s['https://good'].validated,1);
  assert.equal(s['https://good'].submissions,1);assert.equal(s['https://good'].included,1);
  assert.equal(s['https://good'].acceptanceRate,1);assert.equal(s['https://good'].inclusionRate,1);
  assert.equal(s['https://bad'].simulationErrors,1);assert.equal(s['https://bad'].rejected,1);
  assert.equal(s['https://bad'].submissionErrors,1);assert.equal(s['https://bad'].lastError,'rejected');
  assert.equal(s['https://down'].simulationErrors,1);assert.equal(s['https://down'].lastError,'ECONNREFUSED');
});

test('submit still fails closed when no relay accepts the bundle',async()=>{
  const relays=new PrivateRelays(null,['https://r'],undefined,{env:{}});
  await assert.rejects(relays.submit([{url:'https://r',relay:{sendRawBundle:async()=>{throw new Error('timeout');}}}],[tx],2,async()=>{}),/No simulated private relay accepted bundle/);
  assert.equal(relays.status().relays['https://r'].submissionErrors,1);
});
