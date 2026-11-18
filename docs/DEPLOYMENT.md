# Deployment and runtime guide

## Supported deployment status

The supported and locally exercised deployment path is the repository's local runtime and PAPER workflow. The Kubernetes files under `k8s/` are **reference examples**, not a verified, production-ready deployment bundle. They have not been validated against a live cluster, registry, storage class, database, ingress, or secrets provider.

Do not interpret the presence of Kubernetes manifests or GitHub Actions deployment workflows as evidence that staging or mainnet Kubernetes deployment has been commissioned. In particular:

- The checked-in workload manifests hard-code the `flashloan-arb` namespace.
- The staging workflow targets `flashloan-arb-staging`; no matching staging overlay/manifests are supplied.
- The checked-in workload image names use `ghcr.io/flashloan-arb/...`, while the GitHub Actions image build uses the repository path `ghcr.io/klustech/Flashloan-Aabitrage/...`.
- The old `k8s/secret.yaml`, `k8s/configmap-testnet.yaml`, `k8s/configmap-mainnet.yaml`, and `k8s/secret-production.yaml` deployment instructions did not describe files that could be safely and consistently applied. The placeholder Secret manifest has been removed.

For a verified local setup, follow [the project README](../README.md), [environment reference](ENVIRONMENT.md), and [PAPER runbook](commissioning/PAPER_RUNBOOK.md). Keep the bot in PAPER unless you have separately completed the documented LIVE readiness gates.

## 1. Local runtime

From the repository root:

```bash
npm ci
(cd server && npm ci)
(cd frontend && npm ci)
npm run compile
```

Configure the local environment using the tracked `.env.example` as a reference. Keep actual credentials in an untracked `.env` file. Check configuration without printing secret values:

```bash
npm run env:check
```

For the PAPER workflow, keep `PAPER_ONLY=true`, do not provide `PRIVATE_KEY`, and follow the exact preflight and smoke-test sequence in [PAPER_RUNBOOK.md](commissioning/PAPER_RUNBOOK.md). PAPER mode does not sign or submit transactions.

## 2. Kubernetes reference material (not a turnkey deployment)

The manifests are retained to show the intended service topology and selected Kubernetes resources. They are not a verified staging or production installation. Do not run `kubectl apply -f k8s/` as a deployment procedure.

Before using them in a real cluster, an operator must first create and validate an environment-specific overlay that:

1. Sets the intended namespace consistently on every namespaced resource.
2. Uses image names and immutable tags that actually exist in the configured GHCR owner/package.
3. Supplies all referenced Secrets and registry credentials.
4. Provides PostgreSQL and the required Redis service/configuration.
5. Provides a compatible persistent volume/storage class for the ML training PVC, or disables the training resources.
6. Verifies container ports, health endpoints, service exposure, network policies, resource limits, and database connectivity.
7. Keeps mainnet transaction signing disabled until the separate LIVE commissioning gates are satisfied.

The checked-in workload YAML currently uses the `flashloan-arb` namespace. It is not a staging overlay and must not be applied to `flashloan-arb-staging` by changing only the namespace command.

### 2.1 Create the namespace

After preparing and reviewing an environment-specific overlay, create its namespace (example only):

```bash
kubectl create namespace flashloan-arb
```

Use a separate, deliberately prepared overlay and namespace for staging. Do not reuse mainnet configuration for Sepolia.

### 2.2 Create application Secrets from an external file

Never commit a Kubernetes Secret manifest containing credentials, base64-encoded or otherwise. Kubernetes base64 encoding is not encryption.

The tracked [arb-secrets.env.example](../k8s/arb-secrets.env.example) lists the keys referenced by the current example workloads. Copy it to a private location outside the repository, replace every placeholder with values for the target environment, and restrict its permissions:

```bash
install -m 600 k8s/arb-secrets.env.example /tmp/arb-secrets.env
# Edit /tmp/arb-secrets.env using a secure editor; do not paste secrets into shell history.
```

Create/update the Secret in the namespace used by the prepared manifests:

```bash
kubectl create secret generic arb-secrets \
  --namespace flashloan-arb \
  --from-env-file=/tmp/arb-secrets.env \
  --dry-run=client -o yaml | kubectl apply -f -
rm -f /tmp/arb-secrets.env
```

The current example workloads reference these Secret keys:

- Bot: `PRIVATE_KEY`, `RELAY_AUTH_PRIVATE_KEY`, `MAINNET_WEBSOCKET`, `INFURA_KEY`, `REDIS_PASSWORD`
- Redis: `REDIS_PASSWORD`
- ML training job: `DATABASE_URL`

Supply only values actually required by the selected environment. Use a dedicated, least-privilege secret-management system for real deployments; do not use an operator's personal wallet. Never put private keys or RPC credentials in ConfigMaps.

### 2.3 GHCR image-pull authentication

The example Deployments and ML training resources refer to an image-pull Secret named `regcred`. If the corresponding GHCR packages are private, create a GitHub token with read-only `read:packages` permission and create the Secret in the same namespace as the workloads:

```bash
read -r -p "GitHub username: " GHCR_USER
read -r -s -p "GitHub token (read:packages): " GHCR_TOKEN
echo
kubectl create secret docker-registry regcred \
  --namespace flashloan-arb \
  --docker-server=ghcr.io \
  --docker-username="$GHCR_USER" \
  --docker-password="$GHCR_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
unset GHCR_TOKEN
```

If packages are public, image-pull authentication may not be required; remove the `imagePullSecrets` references from the prepared overlay rather than creating an unnecessary credential. Never commit a token or generated Secret YAML.

The current checked-in workload image paths do not match the image paths produced by the repository's staging workflow. Confirm package names and publish immutable tags before deploying; do not assume the `:latest` images in the examples exist.

### 2.4 Configuration examples

[k8s/configuration.example.yaml](../k8s/configuration.example.yaml) contains non-secret example ConfigMaps only. It includes mainnet-oriented defaults and the `flashloan-arb` namespace; inspect and adapt it before use. It is not a Sepolia configuration and is not a complete application configuration for the current bot.

## 3. Staging and mainnet

There is currently **no verified, ready-to-run Kubernetes staging or mainnet procedure in this repository**. The existing CI workflows can build/test code, and deployment workflows describe intended automation, but the checked-in manifests and workflow targets are not aligned sufficiently to claim a reproducible cluster deployment.

Do not run the old commands that referenced missing `configmap-testnet.yaml`, `configmap-mainnet.yaml`, or `secret-production.yaml`. Do not deploy the example mainnet ConfigMap as a substitute for a reviewed production configuration.

A staging deployment becomes supportable only after a staging overlay, staging namespace, package paths/tags, secrets, database/Redis dependencies, storage, and smoke tests have been verified together. Mainnet requires those same checks plus completed contract/security review, monitored operations, key custody, rollback planning, and all LIVE commissioning gates. A Kubernetes deployment alone does not establish profitability or production readiness.

## 4. Monitoring and rollback references

The repository includes example Prometheus and Grafana resources under `k8s/`. They are configuration references, not evidence of a running monitoring stack. Review scrape targets and alerting integration against the actual deployed services before use.

For a cluster that has been independently commissioned, standard Kubernetes rollout inspection/rollback commands are:

```bash
kubectl rollout status deployment/bot-logic-deploy -n flashloan-arb
kubectl rollout history deployment/bot-logic-deploy -n flashloan-arb
kubectl rollout undo deployment/bot-logic-deploy -n flashloan-arb
```

These commands are operational examples only; they do not imply that the example deployment currently exists or is healthy.
