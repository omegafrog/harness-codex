# harness-codex

`harness-codex` turns a product request or engineering change into durable design
artifacts, a ChangeSet, work-item plans, verified implementation evidence, and a
resumable delivery state.

The runtime is artifact-first: each stage writes files, and downstream stages use
those files as their handoff contract instead of relying on conversation history.

## Core Model

- A **ChangeSet** is the session and delivery unit for one coherent change.
- A **work item** is the execution unit inside a ChangeSet. It can be a use case
  or another typed change such as maintenance, a bug fix, refactoring, or a feature
  extension.
- A **work-item workflow** plans, reviews, executes, verifies, and completes one
  work item.
- A separate **ChangeSet finalization workflow** runs once only after every work
  item has a completed plan.
- Runtime state, evidence, reports, and resumable checkpoints are stored under
  `.harness/runs/<RUN-ID>/`.

## Quick Start

Run commands from the target repository root. Installed target repositories use
`./harness`; local harness development can use `python3 -m harness_codex`.

```bash
./harness requirements-definition --title "change title" --idea "short product or engineering goal"
```

This starts the requirements stage and creates or updates the active ChangeSet.
Use the resulting ChangeSet ID in later commands.

## Public Staged Workflow

Run the public stages in this order for the same ChangeSet. A stage must produce
and verify its durable artifacts before the next stage can consume them.

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

The definition stages can pause for focused user input when a required decision
belongs to that stage. A blocked stage records its state and can be continued
rather than restarted from scratch.

| Public stage | Scope | Primary durable output |
| --- | --- | --- |
| `requirements-definition` | ChangeSet | `docs/design/요구사항.md` and active ChangeSet state |
| `ubiquitous-language-definition` | ChangeSet | `context.md` |
| `use-case-definition` | ChangeSet | `docs/design/유스케이스.md` and `docs/use-cases/<UC-ID>/` slices |
| `event-storming` | one use case | `docs/use-cases/<UC-ID>/event-storming.md` |
| `ddd-architecture-definition` | one use case | `docs/use-cases/<UC-ID>/ddd-design.md` and, when needed, `ARCHITECTURE.md` |
| `technical-decisions` | one use case | `docs/use-cases/<UC-ID>/technical-decisions.md` |
| `plan-writing` | one use case | `docs/plans/active/<UC-ID>/plan.md` |
| `implementation` | every unfinished work item in the ChangeSet | code, verification evidence, completed plans, and approved delivery state |

## Before Implementation

The implementation command is ChangeSet-scoped. Do not pass `--uc` to it: the
runtime resolves every unfinished work item belonging to the active ChangeSet.

Before execution, the runtime checks that the ChangeSet and its selected work
items are runnable:

- the active ChangeSet file exists and its ID matches its path;
- at least one affected work item exists;
- every work-item slice exists and satisfies its type-specific document contract;
- use-case work items have their required use-case, event-storming, DDD,
  technical-decision, and E2E-goal documents;
- applicable E2E goals and technical decisions are approved before planning.

A failed preflight is a blocker, not a partial implementation run. Fix or approve
the cited artifact, then continue the ChangeSet.

## What `implementation` Actually Runs

`implementation` has two execution boundaries.

### 1. Per-work-item loop

For each unfinished work item, the runtime materializes a workflow scoped to that
work item and runs the following gates in order:

1. Create or update the active implementation plan.
2. Add applicable security controls to the plan.
3. Review the plan against its scope and test-gate contract.
4. Execute unchecked plan tasks.
5. Run structured verification and write verification evidence.
6. Perform an independent implementation security review.
7. Classify the result as passed, remediable, blocked by an upstream document or
   scope conflict, blocked by the environment, or blocked by unclear verification
   evidence.
8. Complete the work-item plan only when the applicable gates pass. A remediable
   result keeps the plan active and routes back to remediation rather than silently
   completing it.

Completed work-item plans move from:

```text
docs/plans/active/<WORK-ITEM-ID>/plan.md
```

into:

```text
docs/plans/completed/<WORK-ITEM-ID>/plan.md
```

A completed plan is not enough to finish the ChangeSet. On a later implementation
run, completed work items are skipped while finalization is still evaluated.

### 2. ChangeSet finalization loop

After every affected work item has a completed plan, the runtime runs finalization
once:

1. Confirm that all affected work-item plans are complete.
2. Create or reuse the ChangeSet pull request.
3. Move the active ChangeSet to `docs/changes/completed/<CHG-ID>.md` only after
   approved delivery succeeds.

Delivery is fail-closed. The finalization workflow requires the configured
`HARNESS_DELIVERY_APPROVED` approval environment before pull-request delivery and
ChangeSet completion can proceed. Without approval or a successful PR delivery,
the ChangeSet remains active.

## Modes, Continuation, and Inspection

The definition stages and `plan-writing` run as apply stages. `implementation`
supports explicit execution modes:

```bash
./harness implementation CHG-YYYYMMDD-001 --plan
./harness implementation CHG-YYYYMMDD-001 --preview
./harness implementation CHG-YYYYMMDD-001 --apply
```

Use the ChangeSet and run-inspection commands to resume the existing workflow;
do not create a parallel workflow for the same change.

```bash
./harness changes list
./harness changes active
./harness changes show CHG-YYYYMMDD-001
./harness changes contents CHG-YYYYMMDD-001
./harness changes continue CHG-YYYYMMDD-001 --apply
./harness stages list CHG-YYYYMMDD-001
./harness contracts validate CHG-YYYYMMDD-001
./harness artifacts show CHG-YYYYMMDD-001 <stage>
./harness resume run-<RUN-ID>
./harness report run-<RUN-ID>
```

`changes continue` resolves the next incomplete or blocked public stage. When an
upstream requirement or use-case decision must be revised, it reports the owning
stage instead of pretending that the downstream stage can proceed.

## Artifact Layout

```text
docs/design/                         Canonical requirements and use-case documents
docs/changes/active/<CHG-ID>.md      Active ChangeSet
docs/changes/completed/<CHG-ID>.md   Delivered ChangeSet
docs/use-cases/<UC-ID>/              Executor-facing use-case slice
docs/maintenance/<MAINT-ID>/         Typed maintenance slice
docs/plans/active/<WORK-ITEM-ID>/    Incomplete plan
docs/plans/completed/<WORK-ITEM-ID>/ Verified completed plan
.harness/runs/<RUN-ID>/              Runtime state, prompts, evidence, reports, and checkpoints
```

The ChangeSet document is a durable user-facing mirror of runtime progress. The
run state in `.harness/runs/<RUN-ID>/state.json` is the authoritative runtime
record for resume targets, gates, failures, and artifact state.

## Agent Context, Memory, and Evolution

Initialize compact repository-local agent context when setting up a target
repository:

```bash
./harness init --description "repository purpose"
# or
./harness agent-context init --description "repository purpose" --llm
```

The generated repository context is guidance, not a substitute for the active
ChangeSet and selected work-item slice.

`memory` is a file-backed long-term knowledge store. Its current public commands
list, search, and score entries; they do not replace normal workflow gates.

```bash
./harness memory list
./harness memory search "plan contract verification"
./harness memory score candidate.yaml
```

`evolution` manages reviewable guidance proposals created from recorded
intent-alignment feedback. It is for reusable user-intent corrections, not for
ordinary implementation, verifier, test, or environment failures.

```bash
./harness evolution propose --change-set CHG-YYYYMMDD-001 --work-item UC-001 --run-id run-<RUN-ID>
./harness evolution accept EVO-YYYYMMDD-001
./harness evolution reject EVO-YYYYMMDD-001
```

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
