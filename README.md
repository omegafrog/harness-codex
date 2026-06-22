# harness-codex

`harness-codex` turns an idea or change request into a scoped ChangeSet, a
materialized work-item workflow, verified implementation evidence, and a
persisted run record.

The runtime has one official orchestration path and one authoritative execution
state model. `RunnerEngine` executes work; `.harness/runs/<RUN-ID>/state.json`
(`RunState`) decides what ran, what is blocked, and what can resume.

Read the full contract in `docs/architecture/canonical-runtime.md`.

## Install

```bash
python3 -m venv venv
./venv/bin/python3 -m pip install -U pip pytest pyyaml
./venv/bin/python3 -m harness_codex --help
```

When installed in a target repository, use the generated `./harness` launcher.

## Canonical Quick Start

```bash
# Harvest or update design.
./harness harvest --idea "add a change request" --apply --session-id harvest-001

# Create a scoped ChangeSet.
./harness changes create-from-design --title "add a change request" --related-issue "#378"

# Inspect readiness and execute.
./harness changes active
./harness run-change CHG-YYYYMMDD-001 --plan
./harness run-change CHG-YYYYMMDD-001 --apply

# Inspect the persisted runtime result.
./harness resume run-<id>
./harness report run-<id>
```

For a deliberate narrow run, use:

```bash
./harness run-work-item CHG-YYYYMMDD-001 MAINT-001 --apply
./harness run-use-case CHG-YYYYMMDD-001 UC-001 --apply
```

`run-use-case` is a convenience form of `run-work-item` for a use-case work
item. `run-change` is the default for a ChangeSet.

## Command Map

| Goal | Command |
| --- | --- |
| Create or refresh design | `harvest` |
| Create ChangeSet from design | `changes create-from-design` |
| Inspect active work and readiness | `changes active` |
| Execute all ChangeSet work | `run-change` |
| Execute one work item | `run-work-item` |
| Execute one use-case item | `run-use-case` |
| Inspect persisted state | `resume`, `report`, `dashboard` |

Procedure-stage commands and `ultrawork` are legacy entry points. They are not
part of the official command map. Use
`docs/architecture/legacy-command-migration.md` through 2026-09-30.

## State and Artifacts

- `docs/changes/active/<CHG-ID>.md`: change intent and affected work items.
- `docs/use-cases/` and `docs/maintenance/`: executor-facing slices.
- `docs/plans/active/` and `docs/plans/completed/`: plan lifecycle.
- `.harness/runs/<RUN-ID>/state.json`: authoritative runtime state.
- `.harness/runs/<RUN-ID>/report.md`: human-readable run evidence.

Skill wrappers and dashboard/session files are convenience interfaces only. They
must not create a separate completion, resume, or gate state.

## Verification

```bash
./venv/bin/python3 -m pytest -q -s tests/runtime
./venv/bin/python3 -m pytest -q -s
git diff --check
```

For detailed operations, bootstrap policy, and legacy migration, see
`docs/architecture/canonical-runtime.md`.
