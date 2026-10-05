# Documentation

Operator path, in order. No stage is skipped:

```text
LOCAL CORRECTNESS → LOCAL ECONOMICS → ADVERSARIAL / FAILURE → HISTORICAL BENCHMARK
  → PAPER PREFLIGHT → 7-DAY PAPER → COMMISSIONING REPORT → CONTROLLED LIVE
```

| Stage | Read |
|---|---|
| Understand the system | [architecture/BACKRUN_ARCHITECTURE.md](architecture/BACKRUN_ARCHITECTURE.md), [architecture/EXECUTOR_V4.md](architecture/EXECUTOR_V4.md), [architecture/ORDERFLOW.md](architecture/ORDERFLOW.md), [architecture/FUNDING_AND_PROFITABILITY.md](architecture/FUNDING_AND_PROFITABILITY.md) |
| Validate locally | [validation/LOCAL_VALIDATION_BLUEPRINT.md](validation/LOCAL_VALIDATION_BLUEPRINT.md), [validation/ACCEPTANCE_CRITERIA.md](validation/ACCEPTANCE_CRITERIA.md), [validation/HISTORICAL_REPLAY.md](validation/HISTORICAL_REPLAY.md), [validation/SIZE_OPTIMIZATION.md](validation/SIZE_OPTIMIZATION.md), [validation/LATENCY_TESTING.md](validation/LATENCY_TESTING.md), [validation/FAILURE_INJECTION.md](validation/FAILURE_INJECTION.md) |
| Commission | [commissioning/PAPER_PHASE.md](commissioning/PAPER_PHASE.md), [commissioning/PAPER_RUNBOOK.md](commissioning/PAPER_RUNBOOK.md), [commissioning/COMMISSIONING_EVIDENCE.md](commissioning/COMMISSIONING_EVIDENCE.md), [commissioning/LIVE_READINESS.md](commissioning/LIVE_READINESS.md) |
| Operate | [operations/OPERATOR_GUIDE.md](operations/OPERATOR_GUIDE.md), [operations/MONITORING.md](operations/MONITORING.md), [operations/INCIDENT_RESPONSE.md](operations/INCIDENT_RESPONSE.md), [operations/RECOVERY.md](operations/RECOVERY.md) |
| Secure | [security/EXECUTOR_GOVERNANCE.md](security/EXECUTOR_GOVERNANCE.md), [security/KEY_MANAGEMENT.md](security/KEY_MANAGEMENT.md), [security/RELEASE_GATES.md](security/RELEASE_GATES.md) |

Reference and history (not canonical for commissioning):
[BACKRUN_ENGINE.md](BACKRUN_ENGINE.md),
[MAINNET_PAPER.md](MAINNET_PAPER.md) (PAPER stack setup),
[DEPLOYMENT.md](DEPLOYMENT.md), [SECURE_DEPLOYMENT.md](SECURE_DEPLOYMENT.md),
[CONTRACT_LIMITATIONS.md](CONTRACT_LIMITATIONS.md),
[PRODUCTION_COMPLETION.md](PRODUCTION_COMPLETION.md) and design records
([TRANSACTION_TRIGGERED_BACKRUN_BLUEPRINT.md](TRANSACTION_TRIGGERED_BACKRUN_BLUEPRINT.md),
[COMPLETION_BLUEPRINT.md](COMPLETION_BLUEPRINT.md)).
