# harness-codex

`harness-codex` turns an idea or change request into staged artifacts,
ChangeSets, implementation plans, verified execution, and resumable project
state. Stages write durable files; later stages read those files rather than
conversation memory.

## Quick Start

Run commands from the repository root. Installed target repositories use the
`./harness` launcher; local development can use `python3 -m harness_codex`.

## Main Workflow

This is the only supported public workflow. Start from the first stage, then
run the remaining stages in order for the same ChangeSet.

```bash
./harness requirements-definition --title "change title" --idea "short product or engineering goal"
./harness ubiquitous-language-definition CHG-YYYYMMDD-001
./harness use-case-definition CHG-YYYYMMDD-001
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001
./harness ddd-architecture-definition CHG-YYYYMMDD-001 --uc UC-001
./harness technical-decisions CHG-YYYYMMDD-001 --uc UC-001
./harness plan-writing CHG-YYYYMMDD-001 --uc UC-001 --apply
./harness implementation CHG-YYYYMMDD-001 --apply
```

`plan-writing` and `implementation` support `--plan`, `--preview`, and
`--apply`. The implementation stage runs its internal security review,
verification, finalization, and approved delivery gates; those are not separate
public workflow commands.

| Stage command | Main output |
| --- | --- |
| `requirements-definition` | `docs/design/요구사항.md`, active ChangeSet |
| `ubiquitous-language-definition` | `context.md` |
| `use-case-definition` | `docs/design/유스케이스.md`, UC slices |
| `event-storming` | `docs/use-cases/<UC-ID>/event-storming.md` |
| `ddd-architecture-definition` | `docs/use-cases/<UC-ID>/ddd-design.md`, `ARCHITECTURE.md` |
| `technical-decisions` | `docs/use-cases/<UC-ID>/technical-decisions.md` |
| `plan-writing` | `docs/plans/active/<UC-ID>/plan.md` |
| `implementation` | code, tests, verification evidence, completed plan, approved delivery state |

## ChangeSets and Resume

A ChangeSet holds the request, stage status, verification evidence, and resume
point. Use the following supporting commands without substituting a second
workflow.

```bash
./harness changes list
./harness changes active
./harness changes show CHG-YYYYMMDD-001
./harness changes continue CHG-YYYYMMDD-001 --apply
./harness stages list CHG-YYYYMMDD-001
./harness resume run-<id>
./harness report run-<id>
```

## Runtime Operations

```bash
./harness run app
./harness run wiki build
./harness ui-server
```

Project settings and test gates live in `.codex/repository-settings.md` and
`.codex/test-gate.yaml`.

## Verification

```bash
./venv/bin/python3 -m pytest -q -s tests/runtime
./venv/bin/python3 -m pytest -q -s
node --check harness_codex/runtime/dashboard_assets/dashboard.js
```

See `docs/wiki.md` for artifact contracts, dashboard behavior, and operating
rules.
