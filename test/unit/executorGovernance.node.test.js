const test=require('node:test');
const assert=require('node:assert/strict');
const {startupChecks}=require('../../server/bot/readiness');

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const OPERATOR=addr(1),ADMIN=addr(2),RECIPIENT=addr(3),ROUTER=addr(4);

function fixture({admin=ADMIN,adminCode='0x60',executors=[OPERATOR],recipient=RECIPIENT,expectedRecipient=recipient,approved=[ROUTER]}={}){
  const lower=list=>list.map(a=>a.toLowerCase());
  const contract={address:addr(9),executorVersion:async()=>4,admin:async()=>admin,profitRecipient:async()=>recipient,
    executors:async a=>lower(executors).includes(a.toLowerCase()),approvedRouters:async a=>lower(approved).includes(a.toLowerCase()),
    paused:async()=>false,provider:async()=>addr(5),lendingPool:async()=>addr(6)};
  const provider={getNetwork:async()=>({chainId:1}),getCode:async a=>a.toLowerCase()===admin.toLowerCase()?adminCode:'0x60'};
  const profile={chainId:1,expectedAdmin:ADMIN,expectedProfitRecipient:expectedRecipient,routers:{uniswap_v2:{router:ROUTER}},
    flashloanProvider:{addressesProvider:addr(5),lendingPool:addr(6)}};
  return {provider,contract,profile,operatorAddress:OPERATOR,requireSignerGas:false};
}
const failures=async opts=>(await startupChecks(fixture(opts))).checks.filter(c=>!c.passed).map(c=>c.name);
const governanceFailures=async opts=>(await failures(opts)).filter(n=>['executor role','governance','recipient','routers'].includes(n));

test('a separated, contract-administered executor passes the governance checks',async()=>{
  assert.deepEqual(await governanceFailures(),[]);
});
test('readiness rejects an operator without the executor role',async()=>{
  assert.deepEqual(await governanceFailures({executors:[]}),['executor role']);
});
test('readiness rejects the hot operator as admin and an EOA admin',async()=>{
  assert.deepEqual(await governanceFailures({admin:OPERATOR}),['governance']);
  assert.deepEqual(await governanceFailures({adminCode:'0x'}),['governance']);
});
test('readiness rejects profits paid to the hot operator',async()=>{
  // Even when the profile expects it, a hot-key recipient is refused.
  assert.deepEqual(await governanceFailures({recipient:OPERATOR,expectedRecipient:OPERATOR}),['recipient']);
});
test('readiness rejects profile routers that governance has not approved',async()=>{
  assert.deepEqual(await governanceFailures({approved:[]}),['routers']);
});
