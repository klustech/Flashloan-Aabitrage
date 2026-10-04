function safeReason(error){
  const message=String(error?.message||error||"");
  // Provider errors often embed authenticated URLs, calldata and raw order
  // flow. Persist only our short categorical diagnostics.
  if(/^[A-Za-z0-9 _:/+.-]{1,120}$/.test(message)&&!message.includes("://")&&
    !/secret|private.key|password|0x[0-9a-f]{16}/i.test(message)&&
    /^(No |Missing |Backrun |Trigger |Trading |Canonical |Post-trigger |Mixed |Measured |Raw |Signed |Ordered |Historical |Fork |Unexpected |Dedicated |Net |Capital |Amount |Insufficient |Executor |raw_trigger_|simulated_trigger_|amount_exceeds_|insufficient_capital_|flashloan_fee_|no_economically_)/.test(message))
    return message;
  if(error?.name==="AbortError")return "backrun_cancelled_or_expired";
  return "post_trigger_rpc_or_executor_failed";
}
module.exports={safeReason};
