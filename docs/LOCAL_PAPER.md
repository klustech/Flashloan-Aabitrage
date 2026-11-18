# Local PAPER dashboard

This runs the existing dashboard/API against a **local Hardhat fork of Ethereum mainnet**. The fork is local: deployments and simulated calls stay on `127.0.0.1`. The upstream mainnet RPC is used only to read the state from which the fork is created.

No mainnet deployment, funded wallet, or private key is needed. The local Hardhat node supplies unlocked test accounts. The API is started with `PAPER_ONLY=true` and an empty `PRIVATE_KEY`.

## Start it

Use three WSL terminals from the repository root.

1. Stop the old API process on port 3001 with Ctrl+C, if it is currently running. Leave the dashboard on port 3002 running.

2. Terminal 1 — start the local fork:

   ```bash
   npm run local-paper:node
   ```

   Wait until Hardhat reports that the JSON-RPC server is listening on port 18545.

3. Terminal 2 — deploy the v4 executor and local timelock onto that fork:

   ```bash
   npm run local-paper:deploy
   ```

   This verifies the chain ID, executor version, executor role, Aave V2 wiring, router allowlist, and deployed bytecode hash. It writes the local-only API configuration to the ignored file `runtime/local-paper.env`.

4. Terminal 3 — start the existing API in unsigned PAPER mode:

   ```bash
   npm run local-paper:api
   ```

5. Open the existing dashboard at `http://127.0.0.1:3002` and click **PAPER Play**.

The existing coordinator, route discovery, quote sizing, executor `eth_call` checks, and PAPER ledger are reused. A profitable opportunity is recorded as `SIMULATED`; unprofitable or invalid candidates remain rejected with their reasons. No transaction is signed or submitted.

## Stop

Stop the API and local fork with Ctrl+C in their respective terminals. The dashboard can remain running.

## Safety boundaries

- The local fork uses chain ID 1 so the existing Ethereum-only profile and coordinator can run unchanged.
- The API RPC is pinned to `http://127.0.0.1:18545`; backup RPCs are disabled in the generated local environment.
- The deployment script refuses a non-loopback endpoint or a non-local Hardhat network.
- The generated API environment explicitly sets `PAPER_ONLY=true`, `PRIVATE_KEY=`, disables backrun/public-mempool fallback, and disables database credentials.
- The fork is disposable. Restarting it resets local deployments and local state; rerun `npm run local-paper:deploy` after each fork restart.
- This demonstrates fork-based PAPER simulation, not production readiness or guaranteed profitable opportunities.
