# harness-codex

`harness-codex` is a Python runtime for Codex-driven implementation work. It turns an idea or change request into staged artifacts, scoped ChangeSets, use-case or maintenance slices, implementation plans, verified execution, and resumable project state.

Core model: keep design, scope, planning, execution, and verification separate. Each stage writes files. Later stages read those files instead of relying on conversation memory.

## Quick Start

Run commands from repository root.

For local development in this repository:

```bash
python3 -m venv venv
./venv/bin/python3 -m pip install -U pip pytest pyyaml
./venv/bin/python3 -m harness_codex --help
```

When installed into a target repository, use the generated launcher:

```bash
./harness --help
```

Equivalent module form:

```bash
./venv/bin/python3 -m harness_codex --help
```

## Main Workflow

Start from the first runtime stage. This creates a temporary ChangeSet early, records stage state in the ChangeSet, and lets later commands resume from durable files. After use-case design is verified, the runtime finalizes the temporary ChangeSet into a normal `CHG-YYYYMMDD-NNN` ChangeSet generated from the design.

```bash
./harness requirements-definition \
  --title "change title" \
  --idea "short product or engineering goal" \
  --apply
```

Continue through staged workflow:

```bash
./harness use-case-definition CHG-YYYYMMDD-001 --apply
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness ddd-architecture-definition CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness technical-decisions CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness plan-writing CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness implementation CHG-YYYYMMDD-001 --uc UC-001 --apply
```

Use non-mutating modes before writing changes:

```bash
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001 --preview
./harness plan-writing CHG-YYYYMMDD-001 --uc UC-001 --plan
```

Command modes:

- `--plan`: show intended work.
- `--preview`: verify current inputs and outputs.
- `--apply`: run stage, write artifacts, verify, update state.

## Harvest Flow

Use harvest when starting from an early idea and no current design docs exist.

```bash
./harness agent-context init --description "<repo description>"
./harness harvest --idea "<feature idea>" --plan
./harness harvest --idea "<feature idea>" --interactive --session-id harvest-001
./harness harvest sessions
./harness harvest --interactive --session-id harvest-001 --resume
```

After harvest creates canonical design docs, create runtime slices:

```bash
./harness changes create-from-design \
  --title "<change title>" \
  --change-set-id CHG-YYYYMMDD-001
```

## Core Ideas

### ChangeSet

ChangeSet = one change request. It records intent, affected work items, runtime procedure state, verification status, and resume point.

Active ChangeSets live in:

```text
docs/changes/active/
```

Completed ChangeSets move to:

```text
docs/changes/completed/
```

### Slice

Slice = executor-facing scope for one work item.

Use-case slices live in:

```text
docs/use-cases/<UC-ID>/
```

Maintenance slices live in:

```text
docs/maintenance/<MAINT-ID>/
```

Planner and executor read slice docs first. Canonical docs under `docs/design/` are fallback context, not the default execution input.

### Stage Gate

Each stage verifies required artifacts before marking itself complete. Missing files, unresolved approvals, placeholders, or failed test gates block downstream stages.

### File-Backed Resume

Runtime state lives in files, not chat. If a run stops, rerun the same command. Harness reads the ChangeSet, slice docs, plans, and run state before deciding next action.

## Repository Structure

```text
harness_codex/
  cli.py                       CLI entrypoint
  runtime/                     workflow engine, state, verifier, reports, UI server
  runtime/dashboard_assets/    bundled dashboard JS/CSS

.harness/
  workflows/                   YAML workflow definitions
  runs/                        runtime run state
  ui/                          dashboard and harvest session state

.codex/
  repository-settings.md       project-specific agent/runtime settings
  test-gate.yaml               verification commands and gates

docs/
  design/                      canonical requirements and use cases
  changes/                     active/completed ChangeSets
  use-cases/                   executor-facing UC slices
  maintenance/                 executor-facing maintenance slices
  plans/                       active/completed implementation plans
  templates/                   document templates
  agent/                       compact agent context
  wiki.md                      detailed operating guide

tests/
  runtime/                     runtime-focused verification tests
```

## Useful Commands

Inspect ChangeSets:

```bash
./harness changes list
./harness changes active
./harness changes show CHG-YYYYMMDD-001
./harness changes contents CHG-YYYYMMDD-001
```

Run legacy executor flow:

```bash
./harness run-change CHG-YYYYMMDD-001 --plan
./harness run-change CHG-YYYYMMDD-001 --preview
./harness run-change CHG-YYYYMMDD-001 --apply
```

Run one work item:

```bash
./harness run-use-case CHG-YYYYMMDD-001 UC-001 --preview
./harness run-work-item CHG-YYYYMMDD-001 UC-001 --apply
```

Inspect runtime stages and artifacts:

```bash
./harness stages list
./harness artifacts show <artifact-id>
./harness artifacts accept <artifact-id>
./harness resume <run-id>
./harness report <run-id>
```

Start dashboard:

```bash
./harness ui-server
```

Open:

```text
http://127.0.0.1:8765/dashboard
```

Use a custom port:

```bash
./harness ui-server --host 127.0.0.1 --port 9000
```

## Verification

Default runtime test gate:

```bash
./venv/bin/python3 -m pytest -q -s tests/runtime
```

Full local test gate:

```bash
./venv/bin/python3 -m pytest -q -s
```

Fast dashboard checks:

```bash
node --check harness_codex/runtime/dashboard_assets/dashboard.js
python3 -m py_compile harness_codex/runtime/ui_server.py harness_codex/runtime/document_dashboard.py
```

Project-specific gates belong in:

```text
.codex/test-gate.yaml
.codex/repository-settings.md
```

## More Detail

See `docs/wiki.md` for concepts, artifact contracts, workflows, dashboard behavior, and operational rules.
