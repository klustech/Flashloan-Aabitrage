# Flashloan Arbitrage Bot - Operator Guide

> Commissioning, monitoring and incident procedures for the backrun engine live in
> [MONITORING.md](MONITORING.md), [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md), [RECOVERY.md](RECOVERY.md)
> and [../commissioning/PAPER_PHASE.md](../commissioning/PAPER_PHASE.md).

This guide covers day-to-day operation of the Flashloan Arbitrage Bot, including monitoring, troubleshooting, and configuration.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Dashboard Overview](#dashboard-overview)
3. [Bot Control](#bot-control)
4. [Monitoring & Alerts](#monitoring--alerts)
5. [Cross-Chain Operations](#cross-chain-operations)
6. [Timelock Governance](#timelock-governance)
7. [Troubleshooting](#troubleshooting)
8. [API Reference](#api-reference)

---

## Getting Started

### Prerequisites

- Node.js 18+ installed
- PostgreSQL database (optional)
- Redis (optional, for multi-instance)
- Funded wallet with ETH for gas

### Starting the Bot

```bash
# Start the API server
npm start

# Or start with PM2 for production
pm2 start server/scripts/server.js --name flashloan-bot
```

### API Authentication (required)

The API server is **fail-closed**. `API_KEY` MUST be set, or the server refuses
every request. Every route except the health checks requires a matching
`x-api-key` header, so all the `curl` examples below that hit `/api/...` need
`-H "x-api-key: $API_KEY"` added (only `/healthz` works without it). For
browser access, `CORS_ORIGIN` must also be set to the dashboard's origin, and
the dashboard build must embed the same `REACT_APP_API_KEY` — meaning the
dashboard should only run in a trusted operator context.

### Verify Operation

```bash
# Check health endpoint (no API key required)
curl http://localhost:3001/healthz

# Check bot status (requires the API key)
curl http://localhost:3001/api/bot-status -H "x-api-key: $API_KEY"
```

---

## Dashboard Overview

### Key Metrics

| Metric          | Description                            | Healthy Range |
| --------------- | -------------------------------------- | ------------- |
| Bot Active      | Whether automated execution is running | true          |
| Circuit Breaker | Protective mechanism state             | CLOSED        |
| Gas Price       | Current network gas price              | < 50 Gwei     |
| Daily Profit    | Cumulative profit in last 24h          | > 0           |

### Real-Time Feed

The WebSocket connection at `ws://localhost:3001/ws` provides:

- New arbitrage opportunities
- Trade executions
- Price updates
- Connext transfer status

---

## Bot Control

### Start/Stop Bot

```bash
# Start automated execution
curl -X POST http://localhost:3001/api/start-bot

# Stop automated execution
curl -X POST http://localhost:3001/api/stop-bot
```

### Manual Trigger

```bash
# Trigger single arbitrage attempt (with Flashbots)
curl -X POST "http://localhost:3001/api/trigger-arbitrage?flashbots=true"

# Trigger without Flashbots
curl -X POST "http://localhost:3001/api/trigger-arbitrage?flashbots=false"
```

### Update Settings

```bash
# Update gas price ceiling
curl -X POST http://localhost:3001/api/settings \
  -H "Content-Type: application/json" \
  -d '{"gasPriceCeiling": 60}'

# Update slippage tolerance
curl -X POST http://localhost:3001/api/settings \
  -H "Content-Type: application/json" \
  -d '{"slippageBips": 75}'

# Reset to defaults
curl -X POST http://localhost:3001/api/settings/reset
```

### Configuration Options

| Setting            | Default | Description                         |
| ------------------ | ------- | ----------------------------------- |
| `pollingInterval`  | 60      | Seconds between arbitrage attempts  |
| `gasPriceCeiling`  | 50      | Maximum gas price in Gwei           |
| `slippageBips`     | 50      | Slippage tolerance (0.5% = 50 bips) |
| `flashbotsDefault` | true    | Use Flashbots by default            |
| `minBorrowAmount`  | 100     | Minimum flash loan amount           |

---

## Monitoring & Alerts

### Health Checks

```bash
# Basic health check
curl http://localhost:3001/healthz

# Detailed status with all services
curl http://localhost:3001/api/bot-status
```

### Prometheus Metrics

Available at `/metrics`:

```
# Key metrics to monitor
arb_attempts_total          - Total arbitrage attempts
arb_success_total           - Successful executions
arb_failure_total           - Failed attempts by reason
avg_latency_ms              - Average execution latency
avg_profit_dai              - Recent profit amount
```

### Grafana Dashboard

Import the dashboard from `infra/grafana/dashboards/trading-performance.json`.

### Alert Configuration

Set up Slack alerts by configuring:

```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
```

Alerts are sent for:

- Circuit breaker trips
- Consecutive failures
- Connext transfer completions/failures
- Uncaught exceptions

### Circuit Breaker

The circuit breaker protects against cascading failures:

| State     | Description       | Action               |
| --------- | ----------------- | -------------------- |
| CLOSED    | Normal operation  | Attempts allowed     |
| OPEN      | Too many failures | All attempts blocked |
| HALF_OPEN | Recovery testing  | Limited attempts     |

```bash
# Check circuit breaker state
curl http://localhost:3001/api/circuit-breaker

# Manual reset (use with caution)
curl -X POST http://localhost:3001/api/circuit-breaker/reset
```

---

## Cross-Chain Operations

### Connext Status

```bash
# Check Connext integration status
curl http://localhost:3001/api/connext/status

# Check with specific token
curl "http://localhost:3001/api/connext/status?token=0x6B175474E89094C44Da98b954EesaDCAE"
```

### Profit Forwarding

Auto-forwarding is enabled by default when accumulated profits exceed the threshold.

```bash
# Manual forward
curl -X POST http://localhost:3001/api/connext/forward \
  -H "Content-Type: application/json" \
  -d '{"token": "0x6B175474E89094C44Da98b954EesaDCAE"}'
```

### Transfer Monitoring

```bash
# Get transfer history
curl http://localhost:3001/api/connext/transfers

# Get pending transfers
curl http://localhost:3001/api/connext/transfers/pending

# Check specific transfer
curl http://localhost:3001/api/connext/transfers/0xTRANSFER_ID

# Start/stop monitoring
curl -X POST http://localhost:3001/api/connext/monitoring/start
curl -X POST http://localhost:3001/api/connext/monitoring/stop
```

### Transfer States

| Status    | Description                  | Action              |
| --------- | ---------------------------- | ------------------- |
| PENDING   | Transfer initiated           | Wait for completion |
| COMPLETED | Funds arrived on destination | None                |
| FAILED    | Transfer failed              | Check logs, retry   |
| STUCK     | No progress for >30 min      | Contact support     |

---

## Timelock Governance

The executor's admin is `ArbitrageTimelock`, and its only proposer/executor is
the governance multisig. The bot holds no governance key, so the bot API is
read-only for governance: schedule/execute/cancel return 403. See
[EXECUTOR_GOVERNANCE.md](../security/EXECUTOR_GOVERNANCE.md).

### Check Status

```bash
curl http://localhost:3001/api/timelock/status
curl http://localhost:3001/api/timelock/operations/0xOPERATION_ID
curl http://localhost:3001/api/timelock/roles/0xADDRESS
```

### Schedule, Execute, Cancel

Propose `unpause()`, `setExecutor`, `setRouter`, `rescueToken` or a recipient
change from the multisig to the timelock, wait the delay, then execute from the
multisig.

---

## Troubleshooting

### Common Issues

#### Bot Not Executing

1. Check if bot is active: `curl http://localhost:3001/api/settings`
2. Check circuit breaker: `curl http://localhost:3001/api/circuit-breaker`
3. Check gas price: `curl http://localhost:3001/api/gas-estimate`
4. Review logs: `curl http://localhost:3001/api/bot-logs`

#### No Opportunities Found

1. Verify pool connections are active
2. Check liquidity thresholds
3. Ensure price feeds are working
4. Review ML scoring if enabled

#### Transaction Failures

1. Check gas estimation: may be under-estimated
2. Verify slippage settings
3. Check contract has sufficient approvals
4. Review Flashbots bundle status

#### Connext Transfer Stuck

1. Check transfer status via subgraph
2. Verify destination chain is operational
3. Check relayer fee adequacy
4. Contact Connext support if >1 hour

### Log Analysis

```bash
# Get recent logs with pagination
curl "http://localhost:3001/api/bot-logs?offset=0&limit=100"

# Filter by time (in application)
grep "2024-01-15" bot.log
```

### Recovery Procedures

#### After Circuit Breaker Trip

1. Investigate root cause from logs
2. Verify market conditions are normal
3. Reset circuit breaker: `POST /api/circuit-breaker/reset`
4. Monitor first few cycles closely

#### After Contract Pause

1. Identify what triggered the pause
2. Verify contract state on-chain
3. Propose `unpause()` from the governance multisig via the timelock
4. Test with small amounts first

#### After Timeout

1. Bot auto-pauses after timeout
2. Check RPC endpoint responsiveness
3. Verify network conditions
4. Restart bot: `POST /api/start-bot`

---

## API Reference

### Quick Reference

| Endpoint                 | Method   | Description               |
| ------------------------ | -------- | ------------------------- |
| `/healthz`               | GET      | Health check              |
| `/api/bot-status`        | GET      | Comprehensive status      |
| `/api/start-bot`         | POST     | Start automated execution |
| `/api/stop-bot`          | POST     | Stop automated execution  |
| `/api/settings`          | GET/POST | Get/update settings       |
| `/api/trigger-arbitrage` | POST     | Manual trigger            |
| `/api/opportunities`     | GET      | Recent opportunities      |
| `/api/trades`            | GET      | Trade history             |
| `/api/circuit-breaker`   | GET      | Circuit breaker state     |
| `/api/connext/status`    | GET      | Cross-chain status        |
| `/api/timelock/status`   | GET      | Timelock status           |
| `/metrics`               | GET      | Prometheus metrics        |

### Full API Documentation

See `docs/api/openapi.yaml` for complete OpenAPI specification.

---

## Emergency Procedures

### Immediate Stop

```bash
# Stop bot immediately
curl -X POST http://localhost:3001/api/stop-bot

# Or kill the process
pm2 stop flashloan-bot
```

### Contract Emergency Pause

`pause()` is immediate for the executor key or governance:

```bash
cast send $CONTRACT_ADDRESS "pause()" --private-key $PRIVATE_KEY
```

Unpausing requires governance via the timelock.

### Revoke Approvals

```bash
# Revoke token approval to contract
cast send $TOKEN_ADDRESS "approve(address,uint256)" $CONTRACT_ADDRESS 0 \
  --private-key $ADMIN_KEY
```

### Contact Information

- **On-call**: Check internal documentation
- **Escalation**: Follow incident response procedures
- **External**: Connext support, Flashbots Discord

---

## Appendix

### Environment Variables

See `.env.example` for all configuration options.

### Network Configuration

Supported networks:

- Ethereum Mainnet
- Arbitrum
- Optimism
- Polygon
- Base

Each network requires appropriate RPC URLs and contract addresses.

### Maintenance Windows

Schedule regular maintenance for:

- Secret rotation
- Contract upgrades
- Dependency updates
- Performance tuning
