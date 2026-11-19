# Documentation

This index points to the canonical operator and developer documentation. Read the relevant profile and runbook in order; do not skip validation gates.

## For external developers

| Topic | Read |
|---|---|
| Project overview, installation and safety boundaries | [Repository README](../README.md) |
| Historical validation and performance limitations | [Open-source validation notes](OPEN_SOURCE_VALIDATION.md) |
| Environment variables and secret handling | [Environment setup](ENVIRONMENT.md) |
| Contribution process | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Vulnerability reporting | [Security policy](../SECURITY.md) |
| Licensing | [Repository LICENSE](../LICENSE) |

## Operator path

```text
LOCAL CORRECTNESS → LOCAL ECONOMICS → ADVERSARIAL / FAILURE → HISTORICAL BENCHMARK
  → PAPER PREFLIGHT → 7-DAY PAPER → COMMISSIONING REPORT → CONTROLLED LIVE
```

| Stage | Read |
|---|---|
| Understand the system | [architecture/BACKRUN_ARCHITECTURE.md](architecture/BACKRUN_ARCHITECTURE.md), [architecture/EXECUTOR_V4.md](architecture/EXECUTOR_V4.md), [architecture/ORDERFLOW.md](architecture/ORDERFLOW.md), [architecture/FUNDING_AND_PROFITABILITY.md](architecture/FUNDING_AND_PROFITABILITY.md) |
| Validate locally | [validation/LOCAL_VALIDATION_BLUEPRINT.md](validation/LOCAL_VALIDATION_BLUEPRINT.md), [validation/ACCEPTANCE_CRITERIA.md](validation/ACCEPTANCE_CRITERIA.md), [validation/HISTORICAL_REPLAY.md](validation/HISTORICAL_REPLAY.md), [validation/SIZE_OPTIMIZATION.md](validation/SIZE_OPTIMIZATION.md), [validation/LATENCY_TESTING.md](validation/LATENCY_TESTING.md), [validation/FAILURE_INJECTION.md](validation/FAILURE_INJECTION.md) |
| Commission PAPER | [commissioning/PAPER_PHASE.md](commissioning/PAPER_PHASE.md), [commissioning/PAPER_RUNBOOK.md](commissioning/PAPER_RUNBOOK.md), [commissioning/COMMISSIONING_EVIDENCE.md](commissioning/COMMISSIONING_EVIDENCE.md) |
| Understand LIVE gates | [commissioning/LIVE_READINESS.md](commissioning/LIVE_READINESS.md) |
| Operate | [operations/OPERATOR_GUIDE.md](operations/OPERATOR_GUIDE.md), [operations/MONITORING.md](operations/MONITORING.md), [operations/INCIDENT_RESPONSE.md](operations/INCIDENT_RESPONSE.md), [operations/RECOVERY.md](operations/RECOVERY.md) |
| Secure | [security/EXECUTOR_GOVERNANCE.md](security/EXECUTOR_GOVERNANCE.md), [security/KEY_MANAGEMENT.md](security/KEY_MANAGEMENT.md), [security/RELEASE_GATES.md](security/RELEASE_GATES.md) |

## Reference and history

These documents provide additional context and should not override the current commissioning runbooks:

- [BACKRUN_ENGINE.md](BACKRUN_ENGINE.md)
- [MAINNET_PAPER.md](MAINNET_PAPER.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)
- [SECURE_DEPLOYMENT.md](SECURE_DEPLOYMENT.md)
- [CONTRACT_LIMITATIONS.md](CONTRACT_LIMITATIONS.md)
- [PRODUCTION_COMPLETION.md](PRODUCTION_COMPLETION.md)
- [TRANSACTION_TRIGGERED_BACKRUN_BLUEPRINT.md](TRANSACTION_TRIGGERED_BACKRUN_BLUEPRINT.md)
- [COMPLETION_BLUEPRINT.md](COMPLETION_BLUEPRINT.md)
