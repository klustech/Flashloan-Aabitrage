# Key management

| Key | Holds | Lives | Never |
|---|---|---|---|
| Governance multisig | timelock proposer/executor (admin of the executor) | hardware wallets | on the bot host |
| `PRIVATE_KEY` (operator / executor role) | gas ETH only | LIVE bot host | in PAPER, validation or historical environments (all refuse it); as admin |
| `RELAY_AUTH_PRIVATE_KEY` | nothing; relay/builder reputation identity | bot host, persistent across restarts | funded; equal to `PRIVATE_KEY` (refused) |
| Deployment key | deployment gas | deployment environment only | any role after deployment |
| `PROFIT_RECIPIENT` | profits | cold storage | the operator address |

- Rotate any credential pasted into chat, logs or tickets. Treat it as
  compromised.
- RPC URLs embed API keys. Evidence records only the provider host, and
  validation output tails redact URL paths and 32-byte hex values.
- Operator rotation: governance runs `setExecutor(new, true)`, then
  `setExecutor(old, false)`. This changes the profile fingerprint, so PAPER
  continuity and commissioning restart.
