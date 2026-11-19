# Environment and configuration

Configuration is read from environment variables and, for supported processes, a repository-root `.env` file. Shared scripts use `utils/config.js`; server processes use `server/utils/runtimeConfig.js`. Container deployments may inject environment values directly, which take precedence over dotenv files.

## Choose the correct profile

- **Local development and tests:** use only the variables required by the command being run. A mainnet RPC URL is not required for the default in-memory test path.
- **Local fork validation:** follow the relevant validation guide and configure the explicit fork flag and RPC endpoint. Do not point a fork test at a funded signer.
- **Mainnet PAPER:** use the dedicated `server/config/mainnet-paper.env.example` template and follow [MAINNET_PAPER.md](MAINNET_PAPER.md). This is the canonical profile for unsigned mainnet observation.
- **LIVE:** separate deployment and operational process. Do not derive a LIVE configuration by casually editing a PAPER file.

The root `.env.example` is a legacy/general template containing optional integrations and examples for several networks. It is not the canonical mainnet PAPER profile and should not be treated as a production-ready configuration.

## Secret handling

- Never commit `.env`, `.env.mainnet-paper`, populated configuration files, private keys, seed phrases, API keys, RPC credentials, database passwords or relay credentials.
- Keep local secret files owner-readable only (for example, `chmod 600 .env.mainnet-paper`).
- Use dedicated, least-privilege credentials. Do not reuse a personal wallet key.
- Do not paste secrets into issues, pull requests, screenshots, terminal transcripts or support requests.
- Use `npm run env:check` where applicable to check required environment values without printing their contents.

## PAPER requirements

For the documented mainnet PAPER profile:

- `PAPER_ONLY=true`
- `PRIVATE_KEY` must remain empty/unset.
- `BOT_AUTO_START=false`
- `ALLOW_PUBLIC_MEMPOOL_FALLBACK=false`
- Configure the required HTTP/WebSocket RPC endpoints, deployed executor metadata, database credentials and strong API key as described in [MAINNET_PAPER.md](MAINNET_PAPER.md).

The PAPER preflight is a blocking gate. A failed check must be investigated; do not bypass it by adding a private key or weakening the PAPER-only controls.

## Configuration precedence and validation

Environment overrides take precedence over dotenv values. Review the exact profile and its corresponding runbook before changing values. A configuration change can invalidate a commissioning fingerprint or continuity window.

Useful references:

- [Mainnet PAPER setup](MAINNET_PAPER.md)
- [PAPER runbook](commissioning/PAPER_RUNBOOK.md)
- [Backrun architecture](architecture/BACKRUN_ARCHITECTURE.md)
- [Key management](security/KEY_MANAGEMENT.md)
- [Live readiness gates](commissioning/LIVE_READINESS.md)

Do not assume that a variable present in an example file is required, supported on every network, or safe to enable. Check the relevant code path and documentation.
