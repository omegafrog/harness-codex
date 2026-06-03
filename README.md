# harness-codex

Runtime workflow tools for ChangeSet-based Codex implementation. The CLI turns an early change idea into verified stage artifacts, plans, implementation runs, and resumable project state.

Harness uses an agent-backed sequential pipeline, not an agent team runtime. Specialist agents hand off through workflow artifacts and `needs` dependencies. Explicit producer-reviewer gates, such as plan review before execution, are modeled as normal workflow steps. See `docs/runtime-agent-pipeline.md`.

## Installation

Install into a target repository:

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash
```

The installer:

- Copies `harness_codex/`, `.harness/`, `.codex/`, and `tests/runtime` into the target repository.
- Creates a repository-local `venv` unless `--skip-venv` is used.
- Installs `pip`, `pytest`, and `pyyaml` into that `venv`.
- Creates the executable `./harness` launcher.
- Creates missing baseline files such as `ARCHITECTURE.md`, `docs/design/요구사항.md`, `docs/design/유스케이스.md`, `.codex/repository-settings.md`, and `.codex/test-gate.yaml`.
- Preserves runtime state, active ChangeSets, use-case slices, plans, and repository-specific settings during updates.

Install with overwrite:

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --force
```

Install a specific ref or target path:

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --ref main --target /path/to/project
```

Skip virtualenv setup when the project already manages dependencies:

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --skip-venv
```

For local development inside this repository:

```bash
python3 -m venv venv
./venv/bin/python3 -m pip install -U pip pytest pyyaml
./venv/bin/python3 -m harness_codex --help
```

## CLI Basics

After installation, run commands from the target repository root:

```bash
./harness --help
```

All execution commands use one of these modes:

- `--plan`: show what the command would do without changing files.
- `--preview`: verify current inputs and outputs without running agents.
- `--apply`: perform the stage, verify outputs, and update runtime state.

Most implementation commands use a ChangeSet ID:

```bash
./harness <command> CHG-YYYYMMDD-001 --plan
./harness <command> CHG-YYYYMMDD-001 --preview
./harness <command> CHG-YYYYMMDD-001 --apply
```

Use-case-scoped commands also require a UC ID:

```bash
./harness <command> CHG-YYYYMMDD-001 --uc UC-001 --apply
```

## Recommended Workflow

Start from the first runtime stage. This creates a temporary ChangeSet early, records stage state in the ChangeSet, and lets later commands resume from durable files. After use-case design is verified, the runtime finalizes the temporary ChangeSet into a normal `CHG-YYYYMMDD-NNN` ChangeSet generated from the design.

```bash
./harness requirements-definition \
  --title "change title" \
  --idea "short product or engineering goal" \
  --apply
```

Then continue through the named procedure stages:

```bash
./harness use-case-definition CHG-YYYYMMDD-001 --apply
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness ddd-architecture-definition CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness plan-writing CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness implementation CHG-YYYYMMDD-001 --uc UC-001 --apply
```

Before moving to the next stage, use `--preview` to check whether the current artifacts are verified:

```bash
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001 --preview
```

If verification fails, the command reports the missing file, pending approval, or placeholder content that blocks the next stage.

## Runtime Stages

| Stage command | Purpose | Main outputs |
| --- | --- | --- |
| `requirements-definition` | Define project requirements and ubiquitous language. | `docs/design/요구사항.md`, `context.md`, active ChangeSet |
| `use-case-definition` | Define external-actor use cases and runtime UC slices. | `docs/design/유스케이스.md`, `docs/use-cases/<UC-ID>/use-case.md`, `docs/use-cases/<UC-ID>/e2e-goal.md` |
| `event-storming` | Derive commands, events, policies, systems, and invariants for one UC. | `docs/use-cases/<UC-ID>/event-storming.md` |
| `ddd-architecture-definition` | Define DDD components needed by one UC. | `docs/use-cases/<UC-ID>/ddd-design.md`, `docs/use-cases/<UC-ID>/technical-decisions.md` |
| `plan-writing` | Create an executor-ready implementation plan. | `docs/plans/active/<UC-ID>/plan.md` |
| `implementation` | Execute the plan and verify the UC goal. | Updated code, tests, and completed plan state |

Each stage verifies required artifacts before marking itself `verified`. If verification fails, the stage is recorded as `blocked` in the active ChangeSet.

## ChangeSet State

ChangeSets live under:

```text
docs/changes/active/CHG-YYYYMMDD-001.md
docs/changes/completed/CHG-YYYYMMDD-001.md
```

The runtime writes a `Runtime Procedure State` table into the active ChangeSet. That table is the durable resume point for the staged workflow. If a run stops midway, rerun the same stage command; the CLI reads the ChangeSet and current artifacts before deciding what is verified or blocked.

Useful ChangeSet commands:

```bash
./harness changes list
./harness changes active
./harness changes show CHG-YYYYMMDD-001
./harness changes contents CHG-YYYYMMDD-001
```

Create runtime slices from already-written design documents:

```bash
./harness changes create-from-design \
  --title "change title" \
  --change-set-id CHG-YYYYMMDD-001
```

## Legacy Execution Commands

Use these when a ChangeSet already has approved use-case or maintenance slices and you want the older planner/executor path:

```bash
./harness run-change CHG-YYYYMMDD-001 --plan
./harness run-change CHG-YYYYMMDD-001 --preview
./harness run-change CHG-YYYYMMDD-001 --apply
```

Run a single use case or work item:

```bash
./harness run-use-case UC-001 --plan
./harness run-work-item UC-001 --apply
```

## Harvest Commands

Use harvest when starting from an early idea and you want an interactive requirements/use-case flow before creating ChangeSet runtime slices.

```bash
./harness harvest --interactive --idea "short product idea"
```

After harvest completes canonical design documents, create runtime inputs:

```bash
./harness changes create-from-design \
  --title "change title" \
  --change-set-id CHG-YYYYMMDD-001
```

## Artifact and Stage Utilities

List runtime stages:

```bash
./harness stages list
```

Inspect or accept generated artifacts:

```bash
./harness artifacts show <artifact-id>
./harness artifacts accept <artifact-id>
```

Resume or inspect runtime runs:

```bash
./harness resume <run-id>
./harness report <run-id>
./harness dashboard
```

Start the local UI server:

```bash
./harness ui-server
```

Open the workflow dashboard in a browser:

```text
http://127.0.0.1:8765/dashboard
```

The dashboard shows active and completed ChangeSets. Documents associated with an active
ChangeSet can be edited from the dashboard. Completed ChangeSets are available for
read-only review.

Use a different bind address or port when needed:

```bash
./harness ui-server --host 127.0.0.1 --port 9000
```

Then open `http://127.0.0.1:9000/dashboard`.

## Shell Completion

Generate shell completion from the installed runtime:

```bash
./venv/bin/python3 -m harness_codex.runtime.shell_completion install
```

See `docs/runtime-shell-completion.md` for shell-specific setup.

## Verification

The default installed test gate is:

```bash
./venv/bin/python3 -m pytest -q -s tests/runtime
```

Project-specific verification belongs in `.codex/test-gate.yaml` and `.codex/repository-settings.md`. `run-change`, `plan-writing`, and `implementation` use those files to decide whether a plan or ChangeSet can move forward.
