# harness-codex Wiki

This wiki is the deeper operating guide for `harness-codex`. Use `README.md` for quick start. Use this file when deciding how to run workflow stages, where artifacts belong, and how state moves through the runtime.

## 1. Purpose

Harness exists to make Codex implementation work repeatable.

It solves four recurring problems:

- Scope drift: every change starts from a ChangeSet.
- Context overload: executor reads a narrow slice, not every design doc.
- Lost state: runtime progress is written to files.
- Weak verification: each stage defines required artifacts and gates before downstream work proceeds.

Harness is a sequential artifact pipeline. Specialist agents hand off through files and declared workflow dependencies. It is not an agent-team runtime where agents talk directly to each other.

## 2. Mental Model

The workflow has five durable layers:

```text
idea or request
  -> canonical design
  -> ChangeSet
  -> use-case or maintenance slice
  -> plan
  -> implementation and verification evidence
```

Each layer narrows or verifies the layer before it.

Canonical design answers "what product or system should exist?"

ChangeSet answers "what change is being made now?"

Slice answers "what exact work item should executor handle?"

Plan answers "what ordered implementation tasks are safe to run?"

Verification answers "what evidence proves this can merge?"

## 3. Main Artifacts

### Canonical Design

Path:

```text
docs/design/
```

Typical files:

```text
docs/design/요구사항.md
docs/design/유스케이스.md
context.md
```

Canonical design is project-level truth. It should describe requirements, ubiquitous language, actors, and use cases. It should not be treated as the executor's default input once slices exist.

### ChangeSet

Paths:

```text
docs/changes/active/<CHG-ID>.md
docs/changes/completed/<CHG-ID>.md
```

A ChangeSet represents one implementation or documentation change. It records:

- title and intent
- before/after behavior
- affected use-case or maintenance work items
- included and excluded scope
- runtime procedure state
- verification status

The runtime writes a `Runtime Procedure State` table into active ChangeSets. That table is the durable resume point for staged workflow commands.

### Use-Case Slice

Path:

```text
docs/use-cases/<UC-ID>/
```

Common files:

```text
index.md
use-case.md
event-storming.md
ddd-design.md
technical-decisions.md
e2e-goal.md
affected-files.md
```

Use-case slice docs narrow canonical design into executor-facing scope. Planner and executor should read these files before broader design docs.

### Maintenance Slice

Path:

```text
docs/maintenance/<MAINT-ID>/
```

Common files:

```text
index.md
change-intent.md
affected-files.md
technical-decisions.md
verification-goal.md
```

Maintenance slices cover work not naturally expressed as a user-facing use case: refactors, test work, infrastructure changes, docs cleanup, and bug fixes.

### Plan

Paths:

```text
docs/plans/active/<WORK-ITEM-ID>/plan.md
docs/plans/completed/<WORK-ITEM-ID>/plan.md
```

Plans are executor-ready only when tasks are concrete, ordered, scoped to the slice, and tied to verification criteria.

Move a plan to completed only after:

- all checklist items are complete
- use-case E2E goal or maintenance verification goal passes
- required test gates pass
- evidence is recorded in plan or verification notes

## 4. Runtime Stages

Primary staged workflow:

| Stage | Scope | Main outputs |
| --- | --- | --- |
| `requirements-definition` | Project requirements and language | `docs/design/요구사항.md`, `context.md`, active ChangeSet |
| `use-case-definition` | External-actor use cases and UC slices | `docs/design/유스케이스.md`, `docs/use-cases/<UC-ID>/use-case.md`, `e2e-goal.md` |
| `event-storming` | Commands, events, policies, systems, invariants | `docs/use-cases/<UC-ID>/event-storming.md` |
| `ddd-architecture-definition` | UC-scoped DDD architecture | `docs/use-cases/<UC-ID>/ddd-design.md` |
| `technical-decisions` | UC-scoped implementation decisions | `docs/use-cases/<UC-ID>/technical-decisions.md` |
| `plan-writing` | Executor-ready plan | `docs/plans/active/<WORK-ITEM-ID>/plan.md` |
| `implementation` | Code, tests, verification evidence | updated repo files and completed plan state |

Common command form:

```bash
./harness <stage> <CHG-ID> --uc <UC-ID> --apply
```

Stages before UC slicing may not need `--uc`.

Use `--preview` to check whether current artifacts satisfy a stage. Use `--plan` to inspect intended work without writing files.

## 5. Interactive Main-Flow Stages

The first four main-flow `--apply` stages run draft-first Grill-Me loops:

```bash
./harness requirements-definition CHG-YYYYMMDD-001 --apply
./harness ubiquitous-language-definition CHG-YYYYMMDD-001 --apply
./harness use-case-definition CHG-YYYYMMDD-001 --apply
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001 --apply
```

Each loop writes or updates draft artifacts first, asks up to three terminal questions when input is required, stores answers in `.harness/runs/<RUN-ID>/grill-me-session.json`, and reruns the same stage until it completes, blocks, or verification passes.

`ultrawork` remains available as a one-command ChangeSet runner for current design docs:

```bash
./harness ultrawork --title "<change title>" --change-set-id CHG-YYYYMMDD-001 --preview
```

## 6. Dashboard

Start local UI:

```bash
./harness ui-server
```

Open:

```text
http://127.0.0.1:8765/dashboard
```

Dashboard shows:

- active and completed ChangeSets
- related use-case and maintenance docs
- current runtime stage state
- editable active documents
- read-only completed ChangeSets
- workflow session state

Use different host or port:

```bash
./harness ui-server --host 127.0.0.1 --port 9000
```

Dashboard assets live in:

```text
harness_codex/runtime/dashboard_assets/
```

Server-side dashboard projection lives in:

```text
harness_codex/runtime/document_dashboard.py
harness_codex/runtime/ui_server.py
```

## 7. Directory Reference

```text
harness_codex/
  cli.py
  runtime/
    workflow.py
    models.py
    verifier.py
    ui_server.py
    document_dashboard.py
    dashboard_assets/

.harness/
  workflows/
  runs/
  ui/

.codex/
  repository-settings.md
  test-gate.yaml

docs/
  agent/
  changes/
  design/
  maintenance/
  plans/
  templates/
  use-cases/

tests/
  runtime/
```

## 8. Operational Rules

Read order for agents:

1. nearest `AGENTS.md`
2. smallest relevant file under `docs/agent/`
3. active ChangeSet
4. current slice
5. current plan
6. canonical design only when slice needs shared context

Do not rewrite unrelated ChangeSets, slices, plans, or runtime state.

Do not move active plans to completed until verification evidence exists.

Do not edit runtime code for documentation-only work.

Use repository-root `venv` for Python dependencies and tests.

Use `python3` for Python commands.

## 9. Verification Guide

Docs-only change:

```bash
rg -n -P "\p{Hangul}" README.md docs/wiki.md || true
git diff --check
```

Runtime Python change:

```bash
python3 -m py_compile harness_codex/runtime/ui_server.py harness_codex/runtime/document_dashboard.py
./venv/bin/python3 -m pytest -q -s tests/runtime
```

Dashboard asset change:

```bash
node --check harness_codex/runtime/dashboard_assets/dashboard.js
python3 -m py_compile harness_codex/runtime/ui_server.py harness_codex/runtime/document_dashboard.py
```

Full gate:

```bash
./venv/bin/python3 -m pytest -q -s
```

## 10. Troubleshooting

If a stage says artifacts are missing, run same command with `--preview` and inspect required output paths.

If a run stops midway, rerun same stage command. Runtime state is file-backed.

If dashboard looks stale after code edits, restart `ui-server` and confirm served assets changed.

If executor reads too much context, check current ChangeSet and slice docs. Slice docs should be first-class input.

If design and slice conflict, do not resolve inside executor loop. Return to design or ChangeSet stage and update source artifacts first.

## 11. Related Docs

- `docs/runtime-agent-pipeline.md`: sequential artifact pipeline model.
- `docs/runtime-state-source-of-truth.md`: runtime state ownership.
- `docs/runtime-shell-completion.md`: shell completion setup.
- `docs/agent/context.md`: compact repo map for agents.
- `docs/agent/commands.md`: common commands and verification.
