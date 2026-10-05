# Flashloan Arbitrage - Deployment Guide

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Configuration](#environment-configuration)
3. [Local Development](#local-development)
4. [Testnet Deployment](#testnet-deployment)
5. [Mainnet Deployment](#mainnet-deployment)
6. [Monitoring Setup](#monitoring-setup)
7. [Rollback Procedures](#rollback-procedures)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software

- Node.js 18+ and Yarn
- Docker and Docker Compose
- kubectl (for Kubernetes deployments)
- Hardhat (installed via npm)
- Python 3.10+ (for ML service)

### Required Accounts/Keys

- Ethereum RPC endpoint (Infura/Alchemy)
- Flashbots relay access
- PostgreSQL database
- Redis instance (for multi-instance deployments)
- Slack webhook (for alerts)

---

## Environment Configuration

### Core Configuration (.env)

```bash
# Network Configuration
MAINNET_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
MAINNET_WEBSOCKET=wss://mainnet.infura.io/ws/v3/YOUR_KEY
CHAIN_ID=1

# Wallet Configuration (NEVER commit real keys!)
PRIVATE_KEY=0x...
FLASHBOTS_SIGNER_KEY=0x...

# Contract Addresses (mainnet)
AAVE_PROVIDER_ADDRESS=0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5
UNISWAP_V2_ROUTER=0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D
SUSHISWAP_V2_ROUTER=0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F
UNISWAP_V3_ROUTER=0xE592427A0AEce92De3Edee1F18E0157C05861564
UNISWAP_V3_QUOTER=0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
BALANCER_VAULT=0xBA12222222228d8Ba445958a75a0704d566BF2C8

# Token Addresses
DAI_ADDRESS=0x6B175474E89094C44Da98b954EesDeAC495271d0F
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2

# Bot Configuration
MIN_PROFIT_DAI=1
GAS_PRICE_CEILING=100
SLIPPAGE_BIPS=50
MIN_BORROW_AMOUNT=10000
FLASHBOTS_DEFAULT=true

# Database
PG_HOST=localhost
PG_PORT=5432
PG_DB=flashloan_arb
PG_USER=postgres
PG_PASSWORD=your_password

# Redis (optional, for multi-instance)
REDIS_URL=redis://localhost:6379

# ML Service
ML_MODEL_ENDPOINT=http://localhost:4000/score

# Monitoring
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# API Security (REQUIRED)
# The API server is fail-closed: every non-health route requires a matching
# `x-api-key` header, and the server REFUSES all requests if API_KEY is unset.
API_KEY=your_secure_api_key
# CORS is restricted to this origin. It MUST be set to the dashboard origin
# for any browser-based access to work; requests from other origins are blocked.
CORS_ORIGIN=https://dashboard.example.com

# Transaction submission
# Submission is Flashbots/private-relay by default. The public-mempool fallback
# is DISABLED unless you explicitly opt in (leave unset/false in production).
ALLOW_PUBLIC_MEMPOOL_FALLBACK=false
```

### Contract Deployment Parameters (.env)

For Ethereum mainnet production use `npm run deploy:production`; see
[EXECUTOR_GOVERNANCE.md](security/EXECUTOR_GOVERNANCE.md) for the role layout.

`scripts/deploy.js` deploys a self-administered `ArbitrageTimelock` first, then
`ArbitrageFlashloan` with the constructor
`(provider, profitRecipient, admin=timelock, executor=OPERATOR_ADDRESS, routers)`,
then the `ConnextAdapter`. It reads these variables (there is **no**
`MAX_LOSS_BPS` or `FLASHLOAN_PREMIUM_BIPS` — the on-chain max-loss cap was
removed and the Aave premium is read on-chain at runtime):

```bash
# ArbitrageFlashloan
AAVE_LENDING_POOL_ADDRESS_PROVIDER=0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5
PROFIT_RECIPIENT=0x...   # optional; defaults to the deployer address

# Timelock (deployed first, then passed into the ArbitrageFlashloan constructor)
TIMELOCK_MIN_DELAY_SEC=86400          # e.g. 24h delay
TIMELOCK_PROPOSERS=0xProposer1,0xProposer2
TIMELOCK_EXECUTORS=0xExecutor1,0xExecutor2

# Hot bot key (executor role only; never a timelock proposer/executor) and the
# routers/vaults/pools the executor may call
OPERATOR_ADDRESS=0x...
APPROVED_ROUTERS=0xRouter1,0xRouter2

# ConnextAdapter (cross-chain forwarding)
CONNEXT_ADDRESS=0x...
DESTINATION_DOMAIN=<numeric_connext_domain_id>
RECIPIENT_ON_DESTINATION=0x...
```

### Testnet Configuration

For Sepolia testnet, use these addresses:

```bash
CHAIN_ID=11155111
MAINNET_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
AAVE_PROVIDER_ADDRESS=0x0496275d34753A48320CA58103d5220d394FF77F
```

---

## Local Development

### 1. Install Dependencies

```bash
# Install Node dependencies
yarn install

# Install Python dependencies for ML
cd ml && pip install -r requirements.txt && cd ..
```

### 2. Start Local Environment

```bash
# Start all services with Docker Compose
docker-compose up -d

# Or run individually:
# Start Hardhat node
npx hardhat node

# In another terminal, deploy contracts
npx hardhat run scripts/deploy.js --network localhost

# Start the bot
cd server && node scripts/server.js

# Start ML service
cd ml && python ml_scorer.py

# Start frontend
cd frontend && npm start
```

### 3. Run Tests

```bash
# Smart contract tests
npx hardhat test

# Coverage report
yarn coverage

# Fork tests
ENABLE_MAINNET_FORK=true npx hardhat test test/integration/flashloan.spec.js
```

---

## Testnet Deployment

### 1. Deploy Contracts to Sepolia

```bash
# Set environment variables
export DEPLOYER_PRIVATE_KEY=0x...
export SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/...

# Deploy (deploys the timelock, then ArbitrageFlashloan, then ConnextAdapter)
npx hardhat run scripts/deploy.js --network sepolia

# Verify ArbitrageFlashloan on Etherscan. Its constructor takes exactly
# (provider, profitRecipient, admin, executor, routers); the script prints the
# exact command, including the routers array.
npx hardhat verify --network sepolia ARB_FLASHLOAN_ADDRESS \
  $AAVE_LENDING_POOL_ADDRESS_PROVIDER $PROFIT_RECIPIENT $TIMELOCK_ADDRESS $OPERATOR_ADDRESS '[0xRouter1,0xRouter2]'
```

### 2. Deploy Services to Staging

```bash
# Apply Kubernetes configs
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap-testnet.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/bot-deployment.yaml
kubectl apply -f k8s/ml-deployment.yaml
kubectl apply -f k8s/frontend-deployment.yaml

# Verify deployment
kubectl get pods -n flashloan-arb-staging
```

### 3. Configure Bot for Testnet

Update the ConfigMap with testnet addresses:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: bot-config
  namespace: flashloan-arb-staging
data:
  CHAIN_ID: "11155111"
  NETWORK: "sepolia"
  MIN_PROFIT_DAI: "0.1" # Lower threshold for testing
```

---

## Mainnet Deployment

### Pre-Deployment Checklist

- [ ] All tests passing
- [ ] Security audit completed
- [ ] Contract verified on Etherscan
- [ ] Monitoring dashboards configured
- [ ] Alert channels tested
- [ ] Rollback procedure documented
- [ ] Team on-call schedule confirmed

### 1. Deploy Contracts

```bash
# IMPORTANT: Double-check all addresses and parameters
export MAINNET_RPC_URL=https://mainnet.infura.io/v3/...
export DEPLOYER_PRIVATE_KEY=0x...

# Deploy with specific gas settings
npx hardhat run scripts/deploy.js --network mainnet

# Verify immediately
npx hardhat verify --network mainnet DEPLOYED_ADDRESS
```

### 2. Deploy Services

```bash
# Create production namespace
kubectl create namespace flashloan-arb

# Apply secrets (from secure vault)
kubectl apply -f k8s/secret-production.yaml

# Apply configs
kubectl apply -f k8s/configmap-mainnet.yaml

# Deploy services (with rolling update)
kubectl apply -f k8s/bot-deployment.yaml
kubectl apply -f k8s/ml-deployment.yaml
kubectl apply -f k8s/frontend-deployment.yaml

# Monitor rollout
kubectl rollout status deployment/bot-logic-deploy -n flashloan-arb
```

### 3. Post-Deployment Verification

```bash
# Check pod health
kubectl get pods -n flashloan-arb

# Check logs
kubectl logs -f deployment/bot-logic-deploy -n flashloan-arb

# Verify metrics endpoint
kubectl port-forward svc/bot-logic-svc 3001:3001 -n flashloan-arb
curl http://localhost:3001/api/health

# Check Grafana dashboards
# Navigate to your Grafana URL and verify data is flowing
```

---

## Monitoring Setup

### Prometheus Configuration

The bot exposes metrics at `/metrics`. Configure Prometheus to scrape:

```yaml
scrape_configs:
  - job_name: "flashloan-bot"
    static_configs:
      - targets: ["bot-logic-svc:3001"]
    metrics_path: /metrics
    scrape_interval: 15s
```

### Key Metrics to Monitor

| Metric                 | Alert Threshold  | Description          |
| ---------------------- | ---------------- | -------------------- |
| `arb_success_total`    | Rate < 0 for 5m  | No successful trades |
| `arb_failure_total`    | Rate > 10/min    | High failure rate    |
| `daily_pnl_dai`        | < -100 DAI       | Daily loss threshold |
| `gas_price_gwei`       | > GAS_CEILING    | Gas too expensive    |
| `bot_active`           | = 0 unexpectedly | Bot stopped          |
| `consecutive_failures` | > 3              | Circuit breaker risk |

### Grafana Dashboards

Import dashboards from `infra/grafana/dashboards/`:

- `trading-performance.json` - P&L, trade stats, win rate
- `system-health.json` - CPU, memory, latency, errors

---

## Rollback Procedures

### Kubernetes Rollback

```bash
# View rollout history
kubectl rollout history deployment/bot-logic-deploy -n flashloan-arb

# Rollback to previous version
kubectl rollout undo deployment/bot-logic-deploy -n flashloan-arb

# Rollback to specific revision
kubectl rollout undo deployment/bot-logic-deploy --to-revision=2 -n flashloan-arb
```

### Emergency Stop Procedures

1. **Stop Bot via API**:

   ```bash
   curl -X POST https://your-api/api/stop-bot -H "x-api-key: YOUR_KEY"
   ```

2. **Scale Down Deployment**:

   ```bash
   kubectl scale deployment bot-logic-deploy --replicas=0 -n flashloan-arb
   ```

3. **Pause Smart Contract** (if implemented):
   ```bash
   # Using Hardhat console
   npx hardhat console --network mainnet
   > const contract = await ethers.getContractAt("ArbitrageFlashloan", "ADDRESS")
   > await contract.pause()
   ```

### Contract Upgrade Procedure

The current contracts are not upgradeable. For contract changes:

1. Deploy new contract version
2. Migrate funds from old contract (if any)
3. Update bot configuration with new address
4. Redeploy bot services
5. Monitor closely for first 24 hours

---

## Troubleshooting

### Common Issues

#### Bot Not Finding Opportunities

- Check gas price vs ceiling setting
- Verify RPC endpoint is responsive
- Check if pools have sufficient liquidity
- Review `routes_discovered_total` metric

#### High Failure Rate

- Check `arb_failure_total{reason="..."}` for breakdown
- Common reasons: slippage, gas estimation, MEV competition
- Consider increasing slippage tolerance temporarily

#### Transaction Reverts

- Check contract pause status
- Verify sufficient liquidity in Aave
- Remember the contract is profit-or-revert: a route that is no longer profitable after the Aave premium and gas will revert by design. Tune `MIN_PROFIT_DAI` and slippage rather than expecting losing trades to settle.
- Check for contract upgrades on DEXes

#### ML Service Unavailable

- Check ML pod status: `kubectl get pods -l app=ml-scorer`
- Review ML service logs
- Bot will fallback to liquidity-based sorting

### Log Analysis

```bash
# Stream bot logs
kubectl logs -f deployment/bot-logic-deploy -n flashloan-arb

# Search for errors
kubectl logs deployment/bot-logic-deploy -n flashloan-arb | grep -i error

# Export logs for analysis
kubectl logs deployment/bot-logic-deploy -n flashloan-arb > bot-logs.txt
```

### Support Channels

- GitHub Issues: [Repository Issues](https://github.com/your-repo/issues)
- Team Slack: #flashloan-arb-support
- On-Call: Check rotation schedule

---

## Security Considerations

1. **Never commit private keys** - Use environment variables or secret management
2. **Rotate keys regularly** - Especially the Flashbots signer key
3. **Monitor for unauthorized access** - Review API access logs
4. **Keep dependencies updated** - Run `npm audit` regularly
5. **Restrict network access** - Use Kubernetes network policies
6. **Enable audit logging** - Track all configuration changes

---

## Appendix

### Resource Requirements

| Service    | CPU        | Memory      | Replicas |
| ---------- | ---------- | ----------- | -------- |
| Bot        | 500m-1000m | 512Mi-1Gi   | 2        |
| ML Scorer  | 250m-500m  | 256Mi-512Mi | 1        |
| Frontend   | 100m-250m  | 128Mi-256Mi | 2        |
| Redis      | 100m-250m  | 128Mi-256Mi | 1        |
| PostgreSQL | 500m-1000m | 1Gi-2Gi     | 1        |

### Estimated Costs

- Infura/Alchemy: ~$200-500/month (depending on requests)
- AWS/GCP Kubernetes: ~$200-400/month (3-node cluster)
- PostgreSQL (managed): ~$50-100/month
- Total: ~$500-1000/month base infrastructure
