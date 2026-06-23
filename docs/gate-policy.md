# Work-item gate policy

Harness applies a gate matrix per ChangeSet work item instead of treating every repository gate as universally blocking.

## Always fail-closed

- ChangeSet/work-item scope contract
- affected-file placeholder resolution
- plan and verification evidence integrity
- out-of-scope change detection
- plan review and a work-item verification record

## Risk-selected gates

| Gate | Required when | Conditional when | Skipped when |
|---|---|---|---|
| Security review | Auth, token, permission, payment, crypto, or security-sensitive scope | Externally exposed/source behavior with no security marker | Documentation-only or non-exposed maintenance scope |
| Browser/UI | UI files or UI impact are declared | - | No UI scope |
| Runtime server | UI behavior requires a live application | Use-case goal may need runtime evidence | No UI/runtime need |
| Static analysis | Security-sensitive scope | Source change with repository policy | Documentation-only scope |
| Full E2E | Use-case behavior | Maintenance source change when verification goal requires it | Documentation-only/non-product scope |
| Test gate | Use-case behavior | Maintenance source change | Documentation-only scope |

Conditional gates are not silently ignored: the preflight report records a warning, the policy reason, and whether an explicit waiver is allowed. Skipped gates are recorded with a machine-readable reason in the materialized workflow manifest, preflight report, and run metadata.

The policy implementation is `harness_codex.runtime.gate_policy`; its fixture matrix is `tests/fixtures/gate-policy-matrix.yaml`.
