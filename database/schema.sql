-- Flashloan Arbitrage Database Schema
-- Run this script to initialize the PostgreSQL database

-- Create trades table
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    route TEXT NOT NULL,
    profit NUMERIC(38, 18) NOT NULL,
    tx_hash TEXT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on timestamp for efficient querying
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC);

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- Create index on tx_hash for lookups
CREATE INDEX IF NOT EXISTS idx_trades_tx_hash ON trades(tx_hash);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for updated_at
DROP TRIGGER IF EXISTS update_trades_updated_at ON trades;
CREATE TRIGGER update_trades_updated_at
    BEFORE UPDATE ON trades
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Daily PnL view for quick aggregation
CREATE OR REPLACE VIEW daily_pnl AS
SELECT
    DATE(timestamp) as trade_date,
    COUNT(*) as trade_count,
    SUM(profit) as total_profit,
    AVG(profit) as avg_profit,
    MIN(profit) as min_profit,
    MAX(profit) as max_profit
FROM trades
WHERE status IN ('flashbots', 'public', 'success')
GROUP BY DATE(timestamp)
ORDER BY trade_date DESC;

-- Last 24h summary view
CREATE OR REPLACE VIEW pnl_last_24h AS
SELECT
    COUNT(*) as trade_count,
    COALESCE(SUM(profit), 0) as total_profit,
    COALESCE(AVG(profit), 0) as avg_profit
FROM trades
WHERE timestamp >= NOW() - INTERVAL '24 hours'
AND status IN ('flashbots', 'public', 'success');

-- Grant permissions (adjust role name as needed)
-- GRANT ALL PRIVILEGES ON TABLE trades TO your_app_user;
-- GRANT USAGE, SELECT ON SEQUENCE trades_id_seq TO your_app_user;
