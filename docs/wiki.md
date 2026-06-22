# harness-codex Operating Guide

## Canonical Orchestration

Harness has one official execution path:

```text
harvest
  -> changes create-from-design
  -> run-change | run-work-item | run-use-case
  -> resume / report
```

`RunnerEngine` executes each materialized workflow. `RunState`, stored at
`.harness/runs/<RUN-ID>/state.json`, is the source of truth for execution,
artifacts, verification, blockers, and resumption.

A ChangeSet remains the source of truth for **scope**, not for mutable runtime
status. The dashboard, a skill wrapper, a session note, and terminal output
must only project `RunState`; they must not override it.

## Standard Flow

### 1. Harvest design

```bash
./harness harvest --idea "<request>" --apply --session-id harvest-001
```

Reuse `--session-id` with `--resume` when clarification interrupts harvest.
The harvest transcript may hold unanswered questions, but it is not a second
workflow-state machine.

### 2. Create a ChangeSet

```bash
./harness changes create-from-design --title "<title>" --related-issue "#378"
./harness changes active
```

`changes active` is the preflight view: it shows active ChangeSets, their
latest run, work items, plans, verification goals, and readiness blockers.

### 3. Execute

```bash
# default: every ready work item in the ChangeSet
./harness run-change CHG-YYYYMMDD-001 --apply

# intentionally narrow execution
./harness run-work-item CHG-YYYYMMDD-001 MAINT-001 --apply
./harness run-use-case CHG-YYYYMMDD-001 UC-001 --apply
```

All execution commands require exactly one mode:

- `--plan`: show intended scope with no writes.
- `--preview`: validate inputs and current readiness with no writes.
- `--apply`: materialize, execute, verify, and persist the run result.

### 4. Resume and report

```bash
./harness resume run-<id>
./harness report run-<id>
./harness dashboard
```

Resume from the result reported by `RunState`. Do not reproduce a run by
manually copying a table or asking a skill wrapper to infer the next stage.

## Artifact Boundaries

| Artifact | Role |
| --- | --- |
| `docs/design/` | canonical project design |
| `docs/changes/active/` | active ChangeSet scope |
| `docs/use-cases/`, `docs/maintenance/` | work-item slices |
| `docs/plans/active/` | active implementation plan |
| `docs/plans/completed/` | verified completed plan |
| `.harness/runs/` | authoritative runtime state and reports |

## Bootstrap and Wiki Updates

Bootstrap writes compact agent context. Diagnostics such as session-state,
token-reduction, and design-conformance reports are optional; they cannot be
required by prompts, validators, or dashboard views.

Wiki generation distinguishes initial bootstrap from incremental update. An
existing project wiki is preserved unless an explicit update selects a generated
page or navigation element.

## Legacy Migration

Procedure-stage commands and `ultrawork` are not part of the command map. The
migration table is in `docs/architecture/legacy-command-migration.md` and is
maintained through 2026-09-30.
