# harness-codex

`harness-codex` turns a product request or engineering change into durable design
artifacts, a ChangeSet, verified implementation evidence, and resumable delivery
state. Downstream stages consume durable artifacts rather than conversation history.

## Core Model

- A **ChangeSet** is the delivery unit for one coherent change.
- A **work item** is the execution unit inside a ChangeSet.
- A **work-item workflow** completes one selected work item.
- A **ChangeSet finalization workflow** runs only after every work item is complete.
- Runtime state, evidence, reports, and checkpoints are stored in
  `.harness/runs/<RUN-ID>/`.

## Quick Start

Run commands from the target repository root. Installed repositories use
`./harness`; local development can use `python3 -m harness_codex`.

```bash
./harness requirements-definition --title "change title" --idea "short product or engineering goal"
```

The command creates or updates the active ChangeSet. Use its ID in later stages.

## Public Staged Workflow

Run these stages in order for one ChangeSet:

```bash
./harness requirements-definition --title "change title" --idea "short product or engineering goal"
./harness ubiquitous-language-definition CHG-YYYYMMDD-001
./harness use-case-definition CHG-YYYYMMDD-001
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001
./harness ddd-architecture-definition CHG-YYYYMMDD-001 --uc UC-001
./harness technical-decisions CHG-YYYYMMDD-001 --uc UC-001
./harness plan-writing CHG-YYYYMMDD-001 --uc UC-001
./harness implementation CHG-YYYYMMDD-001 --apply
```

| Stage | Scope | Primary output |
| --- | --- | --- |
| `requirements-definition` | ChangeSet | `docs/design/요구사항.md` and active ChangeSet state |
| `ubiquitous-language-definition` | ChangeSet | `context.md` |
| `use-case-definition` | ChangeSet | `docs/design/유스케이스.md` and use-case slices |
| `event-storming` | one use case | `docs/use-cases/<UC-ID>/event-storming.md` |
| `ddd-architecture-definition` | one use case | `docs/use-cases/<UC-ID>/ddd-design.md`, and when needed `ARCHITECTURE.md` |
| `technical-decisions` | one use case | `docs/use-cases/<UC-ID>/technical-decisions.md` |
| `plan-writing` | one use case | `docs/plans/active/<UC-ID>/plan.md` |
| `implementation` | unfinished work items | code, verification evidence, completed plans, and delivery state |

A stage can pause for focused user input or record a blocker. Continue the same
ChangeSet after resolving the cited upstream artifact; do not start a parallel
workflow.

## Implementation Workflow

`implementation` is ChangeSet-scoped. It resolves every unfinished work item and
runs this loop for each item:

1. Create or update the active plan.
2. Add applicable security controls.
3. Review the plan against scope and test-gate requirements.
4. Execute unchecked plan tasks.
5. Run structured verification and write evidence.
6. Run an independent implementation security review.
7. Classify the result and either remediate, route to the owning blocker, or
   complete the plan.

Only a passing work item moves its plan from
`docs/plans/active/<WORK-ITEM-ID>/plan.md` to
`docs/plans/completed/<WORK-ITEM-ID>/plan.md`.

After every affected work item is complete, finalization confirms completion,
creates or reuses the ChangeSet pull request, and moves the ChangeSet to
`docs/changes/completed/<CHG-ID>.md`. Delivery is fail-closed: without the
configured `HARNESS_DELIVERY_APPROVED` approval environment and successful PR
delivery, the ChangeSet remains active.

## Resume and Inspection

```bash
./harness changes list
./harness changes active
./harness changes show CHG-YYYYMMDD-001
./harness changes continue CHG-YYYYMMDD-001 --apply
./harness stages list CHG-YYYYMMDD-001
./harness contracts validate CHG-YYYYMMDD-001
./harness resume run-<RUN-ID>
./harness report run-<RUN-ID>
```

`implementation` supports explicit modes:

```bash
./harness implementation CHG-YYYYMMDD-001 --plan
./harness implementation CHG-YYYYMMDD-001 --preview
./harness implementation CHG-YYYYMMDD-001 --apply
```

## Active Agent and Skill Catalogs

The catalog documents only IDs referenced by the current stage mappings and
active work-item workflow. It does not list every file in `.codex/agents/` or
`.codex/skills/`.

- [Active agents](docs/agents.md)
- [Active skills](docs/skills.md)

## Runtime Operations

```bash
./harness run app
./harness run wiki build
./harness ui-server
```

Project-specific working boundaries and verification commands live in
`.codex/repository-settings.md` and `.codex/test-gate.yaml`.

## Verifying harness-codex Itself

```bash
./venv/bin/python3 -m pytest -q -s tests/runtime
./venv/bin/python3 -m pytest -q -s
node --check harness_codex/runtime/dashboard_assets/dashboard.js
```

See `docs/wiki.md` for artifact contracts, dashboard behavior, and operating
rules.
