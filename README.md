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

Install shell completion:

```bash
./venv/bin/python3 -m harness_codex completion install --shell zsh
# In an installed target repository, use: ./harness completion install --shell zsh
exec zsh
```

## Main Workflow

Start from the first runtime stage. This creates a temporary ChangeSet early, records stage state in the ChangeSet, and lets later commands resume from durable files. After use-case design is verified, the runtime finalizes the temporary ChangeSet into a normal `CHG-YYYYMMDD-NNN` ChangeSet generated from the design.

```bash
./harness requirements-definition \
  --title "change title" \
  --idea "short product or engineering goal"
```

Continue through staged workflow:

```bash
./harness ubiquitous-language-definition CHG-YYYYMMDD-001
./harness use-case-definition CHG-YYYYMMDD-001
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001
./harness ddd-architecture-definition CHG-YYYYMMDD-001 --uc UC-001
./harness technical-decisions CHG-YYYYMMDD-001 --uc UC-001
./harness plan-writing CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness implementation CHG-YYYYMMDD-001 --apply
```

Design stages run directly. Planning and implementation stages retain explicit modes:

```bash
./harness plan-writing CHG-YYYYMMDD-001 --uc UC-001 --plan
./harness implementation CHG-YYYYMMDD-001 --preview
```

Planning and implementation modes:

- `--plan`: show intended work.
- `--preview`: verify current inputs and outputs.
- `--apply`: run stage, write artifacts, verify, update state.

| Stage command | Purpose | Main outputs |
| --- | --- | --- |
| `requirements-definition` | Define project requirements. | `docs/design/요구사항.md`, active ChangeSet |
| `ubiquitous-language-definition` | Define project ubiquitous language. | `context.md` |
| `use-case-definition` | Define external-actor use cases and runtime UC slices. | `docs/design/유스케이스.md`, `docs/use-cases/<UC-ID>/use-case.md`, `docs/use-cases/<UC-ID>/e2e-goal.md` |
| `event-storming` | Derive commands, events, policies, systems, and invariants for one UC. | `docs/use-cases/<UC-ID>/event-storming.md` |
| `ddd-architecture-definition` | Define DDD components needed by one UC. | `docs/use-cases/<UC-ID>/ddd-design.md`, `ARCHITECTURE.md` |
| `technical-decisions` | Define implementation strategy and decision gates for one UC. | `docs/use-cases/<UC-ID>/technical-decisions.md` |
| `plan-writing` | Create an executor-ready implementation plan. | `docs/plans/active/<UC-ID>/plan.md` |
| `implementation` | Execute the plan and verify the UC goal. | Updated code, tests, and completed plan state |

## Run Local Application

Runnable projects keep versioned component launcher contracts:

```text
scripts/run-app-infra.sh
scripts/run-app-server.sh
scripts/check-app-infra.sh  # optional readiness check
```

Implementation plans and executors must maintain these scripts whenever services, ports,
dependencies, startup order, profiles, or environment defaults change. Required local
infrastructure should be defined as code in files such as `compose.yaml`, Dockerfiles,
migrations, and bootstrap scripts.

Restart infrastructure and server in separate detached tmux sessions:

```bash
./harness run app
```

The infrastructure session starts first. When `scripts/check-app-infra.sh` exists, harness
polls it until success before starting the server. Forward project-specific server arguments
after `--`:

```bash
./harness run app --timeout 60 -- --profile local
```

Inspect and control sessions:

```bash
./harness run app status
./harness run app attach infra
./harness run app attach server
./harness run app stop
```

Logs are written to `.harness/logs/app-infra.log` and
`.harness/logs/app-server.log`. Repeated starts immediately replace existing sessions.
`attach` switches the current client when invoked inside tmux and attaches a new client otherwise.

Legacy foreground execution remains available through `scripts/run-app.sh`:

```bash
./harness run app --foreground -- --profile local
```

Tmux mode supports Linux, macOS, and WSL. Keep infrastructure commands foreground inside
tmux; do not add a second detach layer such as `docker compose up -d`.

## Run Project Wiki

When the repository contains the MkDocs wiki contract generated by
`$harness-project-wiki`:

```bash
./harness run wiki install
./harness run wiki
```

The default server address is `127.0.0.1:8000`. Override it when needed:

```bash
./harness run wiki serve --dev-addr 127.0.0.1:8765
```

Run the strict production build:

```bash
./harness run wiki build
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
  ui/                          dashboard and workflow session state

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
./harness changes delete CHG-YYYYMMDD-001
```

Create a ChangeSet from current design docs and run affected workflows:

```bash
./harness ultrawork --title "<change title>" --change-set-id CHG-YYYYMMDD-001 --preview
```

## Artifact and Stage Utilities

List runtime stages:

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
