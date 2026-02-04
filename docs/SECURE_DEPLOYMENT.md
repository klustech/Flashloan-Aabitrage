# Secure Deployment Guide

This guide covers security best practices for deploying the Flashloan Arbitrage Bot in production.

## Secrets Management

### Overview

The bot supports multiple secret sources:

| Source | Use Case | Security Level |
|--------|----------|----------------|
| Environment Variables | Development, CI/CD | Basic |
| Encrypted File | Single server | Good |
| AWS Secrets Manager | AWS deployments | High |
| Azure Key Vault | Azure deployments | High |
| HashiCorp Vault | Multi-cloud | High |

### Option 1: Encrypted File (Recommended for Single Server)

1. **Create secrets file from template:**
   ```bash
   cp server/config/secrets.template.json secrets.json
   # Edit secrets.json with your values
   ```

2. **Encrypt the secrets:**
   ```bash
   node server/utils/secretsManager.js encrypt secrets.json secrets.encrypted YOUR_STRONG_PASSWORD
   ```

3. **Delete the plaintext file:**
   ```bash
   rm secrets.json  # IMPORTANT: Remove plaintext immediately
   ```

4. **Configure environment:**
   ```bash
   export SECRETS_FILE=./secrets.encrypted
   export SECRETS_PASSWORD=YOUR_STRONG_PASSWORD
   ```

5. **Validate secrets:**
   ```bash
   node server/utils/secretsManager.js validate
   ```

### Option 2: AWS Secrets Manager

1. **Create secret in AWS:**
   ```bash
   aws secretsmanager create-secret \
     --name flashloan-bot/production \
     --secret-string file://secrets.json
   ```

2. **Configure IAM policy:**
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["secretsmanager:GetSecretValue"],
       "Resource": "arn:aws:secretsmanager:*:*:secret:flashloan-bot/*"
     }]
   }
   ```

3. **Configure environment:**
   ```bash
   export AWS_SECRET_NAME=flashloan-bot/production
   export AWS_REGION=us-east-1
   ```

### Option 3: Azure Key Vault

1. **Create secrets in Key Vault:**
   ```bash
   az keyvault secret set --vault-name your-vault --name PRIVATE-KEY --value "0x..."
   ```

2. **Configure environment:**
   ```bash
   export AZURE_VAULT_URL=https://your-vault.vault.azure.net/
   ```

### Option 4: HashiCorp Vault

1. **Store secrets in Vault:**
   ```bash
   vault kv put secret/flashloan-bot/prod \
     PRIVATE_KEY="0x..." \
     MAINNET_RPC_URL="https://..."
   ```

2. **Configure environment:**
   ```bash
   export VAULT_ADDR=https://vault.example.com
   export VAULT_SECRET_PATH=secret/data/flashloan-bot/prod
   export VAULT_TOKEN=your-vault-token
   ```

## Private Key Security

### Best Practices

1. **Use a dedicated wallet** - Never use your main wallet
2. **Hardware wallet signing** - Consider HSM or hardware wallet integration
3. **Minimal balance** - Only keep gas funds in the hot wallet
4. **Key rotation** - Rotate keys periodically

### Key Generation

Generate a secure private key:

```bash
# Using OpenSSL
openssl rand -hex 32

# Using Node.js
node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))"
```

### Hardware Security Module (HSM) Integration

For high-value deployments, consider:

- AWS CloudHSM
- Azure Dedicated HSM
- YubiHSM
- Ledger Enterprise

## Network Security

### Firewall Rules

```bash
# Allow only necessary ports
ufw allow 22/tcp     # SSH (restrict to specific IPs)
ufw allow 3000/tcp   # API (internal only)
ufw allow 9090/tcp   # Prometheus (internal only)
ufw default deny incoming
ufw enable
```

### RPC Endpoint Security

1. **Use private RPC endpoints** (Alchemy, Infura, QuickNode)
2. **Enable IP whitelisting** on your RPC provider
3. **Use WebSocket connections** for real-time data
4. **Implement rate limiting**

### API Security

The API server should:
- Be behind a reverse proxy (nginx)
- Use HTTPS with valid certificates
- Implement rate limiting
- Require authentication for sensitive endpoints

Example nginx config:

```nginx
server {
    listen 443 ssl;
    server_name api.yourdomain.com;

    ssl_certificate /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    location /api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_set_header X-Real-IP $remote_addr;

        # Rate limiting
        limit_req zone=api burst=20 nodelay;
    }
}
```

## Kubernetes Security

### Pod Security

```yaml
apiVersion: v1
kind: Pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
  containers:
  - name: bot
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
          - ALL
```

### Secrets Management in K8s

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: flashloan-secrets
type: Opaque
stringData:
  PRIVATE_KEY: <base64-encoded>
  MAINNET_RPC_URL: <base64-encoded>
```

Use External Secrets Operator for cloud provider integration.

## Monitoring & Alerts

### Security Alerts

Configure alerts for:
- Failed transaction attempts
- Unusual gas spending
- Contract balance changes
- API authentication failures
- System resource anomalies

### Audit Logging

Enable comprehensive logging:
- All transaction attempts
- Configuration changes
- API access logs
- System events

## Incident Response

### Checklist

1. **Detect** - Monitor for anomalies
2. **Contain** - Pause the bot immediately
3. **Investigate** - Review logs and transactions
4. **Remediate** - Fix the issue
5. **Recover** - Restore operations
6. **Post-mortem** - Document lessons learned

### Emergency Procedures

```bash
# Emergency pause via API
curl -X POST http://localhost:3000/api/bot/stop

# Emergency contract pause (if you're the owner)
cast send $CONTRACT_ADDRESS "pause()" --private-key $ADMIN_KEY

# Revoke approvals
cast send $TOKEN_ADDRESS "approve(address,uint256)" $CONTRACT_ADDRESS 0 --private-key $ADMIN_KEY
```

## Compliance Checklist

- [ ] Private keys stored securely (not in plaintext)
- [ ] Secrets not committed to version control
- [ ] RPC endpoints use HTTPS/WSS
- [ ] API endpoints authenticated
- [ ] Firewall configured
- [ ] Monitoring enabled
- [ ] Alerts configured
- [ ] Audit logging enabled
- [ ] Incident response plan documented
- [ ] Regular security reviews scheduled

## Environment-Specific Configurations

### Development
```bash
# .env.development
NODE_ENV=development
LOG_LEVEL=debug
# Use testnet addresses
```

### Staging
```bash
# .env.staging
NODE_ENV=staging
LOG_LEVEL=info
# Use testnet with production-like config
```

### Production
```bash
# .env.production
NODE_ENV=production
LOG_LEVEL=warn
# Use encrypted secrets or cloud provider
```

## Security Updates

Keep dependencies updated:

```bash
# Check for vulnerabilities
npm audit

# Update dependencies
npm update

# Check for critical updates
npm outdated
```

---

For questions or security concerns, contact the development team.
