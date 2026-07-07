# Runtime Consolidation

## Goal

The runtime must be understood by responsibility rather than the order in which
compatibility fixes were added. The active command path has one explicit
composition root, one session coordinator, one canonical work-item state
projection, and read-only dashboard data.

## Active execution path

```text
python -m harness_codex
  -> bootstrap.configure_runtime()
  -> entrypoint.main()
  -> ChangeSetSessionCoordinator
  -> WorktreeService + RunnerEngine + StepLedgerProgressReporter
  -> canonical RunState v2 + saved dashboard projection
```

`harness_codex` and `harness_codex.runtime` are import-safe export surfaces.
They do not install extensions, replace CLI functions, or start background
threads merely because an application imports them.

## Completed consolidation

| Responsibility | Previous shape | Active owner | Result |
|---|---|---|---|
| Legacy no-scope preflight | `preflight_policy_patch.py` | `preflight.py` | Deleted; Docker remains a hard blocker and legacy waiver behavior is tested. |
| Engine step ledger | `step_transaction_patch.py` | `RunnerEngine` | Deleted; executed, skipped, and policy-blocked steps are written directly. |
| Security verification routing | `structured_verification_routing.py` | `RunnerEngine` | Deleted; security review failures retain implementation-repair routing. |
| Package composition | package import installers | `bootstrap.py` | Package initializers are side-effect free. |
| CLI execution boundary | `cli._apply_workflow` reassignment | `entrypoint.py` | Public implementation and implementation-resume paths call the coordinator directly. |
| Session progress | `main_session_progress_patch.py` | `session_progress.py` | Deleted; a caller-owned ledger reporter runs around the session. |
| Worktree lifecycle boundary | coordinator helper sprawl | `WorktreeService` | Active coordinator delegates prepare, repair, merge, and commit operations. |
| Run state duplication | use-case and work-item parallel storage | `state_projection.py` | New saves are schema v2 work-item records; legacy JSON migrates at startup. |
| Dashboard reads | request-time run-directory scans | saved dashboard index | Dashboard reads `.harness/dashboard/index.json` only. |
| Dashboard legacy bridge/compat | import-time bridge and compat patches | `dashboard_legacy_migration.py` | Deleted; old harvest and procedure-table data migrates once at command startup. |
| Token metrics after trace compaction | `token_observability_trace_retention_patch.py` | `token_observability.py` | Deleted; provider usage falls back to compact result metadata. |
| Trace cleanup references | `agent_trace_reference_cleanup_patch.py` | `agent_trace_retention_patch.py` | Deleted; retention removes step and run-root log references together. |

## State and dashboard contract

`persist_canonical_run_state` is the save boundary for public ChangeSet sessions.
It normalizes legacy `UseCaseLoopState` rows into `WorkItemLoopState`, records
`runtime_state_schema_version: 2`, writes the state JSON, then writes both the
per-run snapshot and the dashboard index. Dashboard endpoints do not mutate
state or glob run directories.

Startup migration is idempotent:

1. migrate legacy scoped dashboard/harvest sessions;
2. migrate old run JSON into canonical work-item state;
3. refresh dashboard snapshots and index.

## Compatibility policy

`bootstrap.py` is intentionally still a composition root for specialized
compatibility hooks that affect provider invocation, interactive UI behavior,
and DDD artifact contracts. They are explicit and ordered there; no patch
installs another patch as a hidden side effect.

A hook may be deleted only when its behavior is moved into its owner module and
covered by a focused test. Do not delete the remaining specialized hooks merely
because their imports are centralized.

## Remaining focused extractions

These are bounded follow-up items, not alternative active execution paths:

1. Physically move the legacy Git helper bodies behind `WorktreeService`; the
   coordinator already depends only on the service boundary.
2. Absorb the remaining provider/interactive/DDD compatibility hooks into
   `runner`, `harvest_ui`, and DDD service modules one owner at a time.
3. Split the legacy `changeset_orchestrator` helper module into workflow
   materialization, finalization, reporting, and compatibility adapters after
   external callers have moved to `session_coordinator`.
4. Rename contract validator modules after a compatibility re-export is added.

## Guardrails

- Imports must not mutate runtime callables.
- A public session must use `ChangeSetSessionCoordinator`, never a patched CLI
  function.
- State schema migration and dashboard reads are separate: migration writes;
  dashboard only reads saved projections.
- Worktree implementation stays behind `WorktreeService`.
- Every deleted compatibility hook needs a behavior test and a CLI smoke check.
