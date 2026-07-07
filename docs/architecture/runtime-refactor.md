# Runtime Consolidation Plan

## Goal

The runtime must be understandable by responsibility, not by the chronological
order in which compatibility fixes were added. The target is a small explicit
composition root with one authoritative execution path, one state model, and
read-only dashboard projections.

This document is intentionally implementation-oriented. It defines what may be
deleted only after its behavior has been moved into the owning module and is
covered by a focused test.

## Current diagnosis

### 1. Importing the package changes runtime behavior

Both package initializers install compatibility layers during import. Those
layers replace methods on the CLI, `RunnerEngine`, preflight helpers,
ChangeSet orchestration, dashboard projections, and UI script builders.

Consequences:

- import order can change behavior;
- the definition of a public behavior is split between a core module and one or
  more `*_patch.py` modules;
- direct imports of a core module and imports through `harness_codex.runtime`
  can run different behavior;
- tests cannot identify the true composition boundary without importing the
  whole package.

### 2. One work-item model is represented twice

`UseCaseLoopState` and `WorkItemLoopState` have nearly identical status,
verification, retry, blocker, and executor/verifier result fields. `RunState`
also stores parallel use-case and work-item ID collections.

A use case is a work-item type. The runtime should store one `WorkItemState`
with `work_item_type`, while compatibility readers project legacy use-case
fields only when reading older persisted JSON.

### 3. The session orchestrator owns too many unrelated concerns

`changeset_orchestrator.apply_workflow` currently coordinates:

- selected work-item execution;
- workflow materialization and manifests;
- worktree lifecycle and merge repair;
- finalization;
- run-state construction;
- report writing.

These need explicit collaborators. A coordinator should decide sequence, not
contain Git worktree implementation and persistence policy.

### 4. Dashboard state is mutated through a compatibility chain

Canonical runtime state, legacy bridge/compatibility code, dashboard gate
patches, harvest patches, and final-result patches all update overlapping
stage views. Some dashboard behavior scans the run directory on each request
and patches frontend JavaScript strings at runtime.

The dashboard must instead read a versioned projection derived from `RunState`
and `RunReport`. Legacy sessions should migrate once, rather than remain on the
normal request path.

## Target module layout

```text
harness_codex/runtime/
  bootstrap.py                 # Explicit production composition only
  execution/
    engine.py                  # Workflow graph, policies, retries, remediation
    step_ledger.py             # SQLite transaction boundary for executed/skipped/blocked steps
    verification.py            # Verification report -> failure classification
    preflight.py               # Scope policy and deterministic checks
  session/
    coordinator.py             # ChangeSet and work-item sequencing
    worktree_service.py        # Isolated worktree/merge lifecycle
    finalization.py            # One ChangeSet completion transition
    progress.py                # Optional observer, injected by the CLI
  state/
    models.py                  # RunState + WorkItemState only
    store.py                   # JSON persistence and schema migration
    projection.py              # CLI/dashboard/read-model projections
  dashboard/
    service.py                 # Read-only data endpoints
    assets/                    # Static UI assets; no runtime string surgery
  changes/
  contracts/
  adapters/
    cli_agent.py
    shell.py
    git.py
```

The directory split is a target, not a requirement to make one massive rename
commit. Moves must happen only after behavior is covered in the owner module.

## Ownership map and deletion candidates

| Current responsibility | Current shape | Target owner | Deletion condition |
|---|---|---|---|
| Legacy no-scope preflight policy | `preflight_policy_patch.py` | `preflight.py` | Complete in this change: behavior moved and focused tests added. |
| Structured verification failure routing | `structured_verification_routing.py` plus engine hook | `execution/verification.py` and `engine.py` | Preserve security-review -> remediation behavior and verification-report metadata. |
| Step transaction ledger | `step_transaction_patch.py` | `execution/step_ledger.py` / engine execution boundary | Record normal, skipped, and policy-blocked terminal steps without replacing engine methods. |
| Main-session progress | `main_session_progress_patch.py` | `session/progress.py` | Inject observer into coordinator; progress stays backed by durable step ledger. |
| ChangeSet execution boundary | top-level package installer | CLI command handler | `cli.py` calls coordinator explicitly; no reassignment of `cli._apply_workflow`. |
| Dashboard runtime/legacy state | runtime state + bridge + compat + dashboard patches | `state/projection.py` and one migration command | Every supported state schema projects identically after migration. |
| Verification repair UI | dashboard/UI patch modules | dashboard service projection | Recovery history is stored in run reports; endpoint does not glob all run artifacts per request. |
| Use-case/work-item loop state | parallel state models | `WorkItemState` | JSON loader reads legacy state and rewrites canonical schema on save. |
| Contract validation naming | `contracts/validators.py` and `contract_validators.py` | `contracts/registry_validation.py`, `contracts/runtime_validation.py` | All import sites move and public API is preserved through a temporary re-export. |

## Migration phases

### Phase 1 — absorb isolated compatibility policy

- Move the legacy no-scope preflight rule into `preflight.py`.
- Delete `preflight_policy_patch.py` and its import-time installer.
- Add focused tests proving non-Docker waiver and Docker hard-block behavior.

**Status:** implemented by this branch.

### Phase 2 — remove `RunnerEngine` monkey patches

- Move verification report classification, including security review routing,
  into `RunnerEngine` or an explicit verifier collaborator.
- Move transaction begin/finish and terminal-step recording into an explicit
  engine-owned ledger collaborator.
- Delete `structured_verification_routing.py` and `step_transaction_patch.py`.
- Keep `RunnerEngine` behavior equivalent under direct import and CLI import.

**Acceptance:** a test runs the same workflow through direct engine construction
and CLI composition and compares `RunResult` plus ledger rows.

### Phase 3 — make session composition explicit

- Replace top-level `_install_changeset_execution_boundary` with a CLI call to
  `ChangeSetSessionCoordinator`.
- Extract worktree/merge implementation from `changeset_orchestrator.py`.
- Inject a `ProgressReporter` instead of wrapping `apply_workflow` in a
  background-thread patch.

**Acceptance:** no assignment to CLI or orchestrator callables occurs during
package import.

### Phase 4 — canonical state and dashboard projection

- Replace use-case/work-item parallel state collections with canonical
  `WorkItemState` records.
- Introduce a state schema version and an idempotent migration function.
- Make dashboard endpoints consume a saved projection, not mutate state or
  scan all run artifacts during request rendering.
- Remove legacy state bridge/compat and dashboard script patch modules after
  migration coverage exists.

**Acceptance:** an old state fixture and new state fixture produce the same
stage and recovery dashboard projection.

### Phase 5 — package boundaries and command surface

- Keep `harness_codex.runtime.__init__` as exports only; it must not execute
  installation code.
- Make `bootstrap.py` the only production composition root.
- Group CLI commands by bounded responsibility (`changes`, `design`,
  `implementation`, `operations`) while retaining aliases only where telemetry
  proves external use.
- Move operational helpers (`reset`, `self_update`, `shell_completion`, app
  lifecycle, wiki) out of core execution imports.

**Acceptance:** `python -c 'import harness_codex.runtime'` does not alter class
methods or start threads.

## Guardrails

1. Do not delete a patch because it appears unreferenced before checking nested
   installers. Several patches currently install other patches.
2. Every removal needs a focused behavior test before deletion and one CLI
   import smoke test after deletion.
3. Do not mix state-schema migration with worktree or dashboard UI changes in
   the same pull request.
4. Preserve the durable artifacts under `.harness/runs/<run-id>/`; change the
   reader/projection layer before changing the artifact producer.
5. Prefer dependency injection and composition over `setattr`/method
   replacement. A compatibility wrapper is acceptable only at an explicit
   versioned migration boundary.

## Immediate follow-up order

1. Phase 2: engine verification and ledger integration.
2. Phase 3: coordinator/worktree/progress split.
3. Phase 4: canonical work-item state and dashboard projection.
4. Phase 5: package initializer and CLI surface cleanup.
