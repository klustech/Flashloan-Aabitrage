CREATE TABLE IF NOT EXISTS executions (
  id UUID PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('PAPER','LIVE','STOPPED','PAUSED','LIVE_ARMED')),
  status TEXT NOT NULL CHECK (status IN ('DISCOVERED','SIMULATED','SUBMITTED','INCLUDED','REVERTED','DROPPED')),
  borrow_token TEXT,
  token_decimals SMALLINT,
  tx_hash TEXT,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS executions_status_idx ON executions(mode,status,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS executions_tx_idx ON executions(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE OR REPLACE VIEW realized_execution_pnl AS
SELECT borrow_token, token_decimals,
  COUNT(*) AS settled_trades,
  SUM((payload->>'realizedNetProfit')::NUMERIC) AS realized_net_base_units,
  SUM((payload->>'actualGasCostNative')::NUMERIC) AS actual_gas_native_wei
FROM executions WHERE mode='LIVE' AND status IN ('INCLUDED','REVERTED')
GROUP BY borrow_token,token_decimals;
