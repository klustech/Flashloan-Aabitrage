# Operator workspace

The dashboard has one navigation shell for Overview, Executions, Route explorer, Opportunities, Simulator, ML analytics, and System & settings. The desktop sidebar becomes a horizontal navigation strip on narrow screens. Trading controls remain available across pages.

## Data and controls

- `/api/trading` supplies a shared status snapshot, refreshed every 15 seconds, with an explicit connection/staleness indicator. Child production panels share this request. WebSocket messages on the opportunity page request a refreshed ledger snapshot; their legacy profit payload is not treated as authoritative.
- Overview money values come from settled production accounting, separated by borrow token. Integer base-unit strings are formatted with registry decimals without conversion to floating point. The performance chart uses only settled LIVE records in the available 100-record window; the account total covers the full ledger. PAPER expected profit never enters realized performance.
- Execution details retain pool identities, swap directions, expected costs, actual settlement and separate contract/bundle simulation status. PAPER bundle simulation is explicitly unsigned and not run.
- PAPER, arm, GO LIVE and emergency pause call the existing trading endpoints. A fresh status and unexpired armed window are required for GO LIVE in the UI; the backend remains the authority for readiness and execution guards. Live readiness inspection is read-only.
- Settings submit the existing validated settings schema. Legacy polling and simulation fields are identified separately from block-driven production scanning. Service availability is labeled as reported by the API. Missing values remain unknown.
- The manual Simulator remains an illustrative legacy calculation. It does not obtain executable quotes, validate the production transaction or sign a trade. Production on-chain results appear in PAPER execution records.

## Update an existing private dashboard

From the existing repository checkout, with a clean working tree:

```sh
git pull --ff-only origin main
cd frontend
REACT_APP_PRIVATE_DASHBOARD=true npm run build
```

Restart the existing dashboard server process to serve the updated build. Keep the existing API, fork node, mining process and runtime evidence running. This frontend update requires no contract redeployment, fork reset or API configuration change. Keep the API key in the server-side dashboard proxy configuration; do not put it in a React build variable. For an Auth0 deployment, retain its existing frontend environment settings instead of enabling private-dashboard mode.

## Validation

Frontend regressions cover workspace navigation, shared polling, connection failures, ledger filtering and details, six-decimal settled accounting, exclusion of PAPER from realized profit, unsigned bundle labels, arm expiry, readiness inspection, illustrative simulation and validated settings payloads. The optimized frontend build is also checked. Browser preview access to the local server was blocked in the implementation environment, so automated DOM tests and responsive CSS checks do not constitute a rendered desktop/mobile visual acceptance test.
