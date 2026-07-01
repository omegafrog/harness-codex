# Harness Document Structure

## 0. Quick install for a new repository

For a new repository, download the GitHub installer and choose whether to install the full runtime or only bundled skills.

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash
```

When an interactive terminal is available, the installer asks for one mode:

- `runtime`: installs runtime files, bundled skills, launcher, runtime tests, docs, and venv.
- `skills-only`: installs only `.codex/skills`.

Non-interactive runs default to `runtime`. Pass a mode explicitly for scripted installs:

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --runtime
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --skills-only
```

Runtime mode:

- Installs `harness_codex/`, `.harness/`, `.codex/`, `completions/`, and `tests/runtime` into the target project.
- Creates `venv` and installs `pip`, `pytest`, and `pyyaml`.
- Creates the root launcher `./harness`.
- Creates `ARCHITECTURE.md`, `docs/design/요구사항.md`, `docs/design/유스케이스.md`, `.codex/repository-settings.md`, and `.codex/test-gate.yaml` when missing.
- Runs the `./harness --help` smoke test.

Existing files are not overwritten by default. Use `--force` to refresh managed files:

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --runtime --force
```

You can also choose a ref or target directory.

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --runtime --ref main --target /path/to/project
```

After installation, start with repository context and the first runtime stage.

```bash
./harness init \
  --description "New project managed by harness-codex runtime"

./harness requirements-definition CHG-YYYYMMDD-001 \
  --title "initial runtime setup" \
  --idea "initial runtime setup" \
  --plan
```

## 1. Agent Context Bootstrap

New repositories that use this harness should bootstrap repo-local agent context before
running the staged ChangeSet workflow.

```bash
./harness init --description "<repo description>"
```

The bootstrap creates a short `AGENTS.md` and cold-path context files under
`.harness/docs/agent/`. If an existing root `AGENTS.md` is not harness-managed, the
bootstrap preserves it and records that decision in `.harness/docs/agent/session-state.md`.
With LLM analysis enabled, bootstrap reverse-engineers the existing codebase into
baseline requirements, ubiquitous language, canonical use cases, per-use-case E2E
goals, event-storming slices, DDD design slices, and `ARCHITECTURE.md`. It also writes
implementation inventory to `.harness/docs/agent/codebase-artifacts.md` and compares code
evidence with reconstructed or existing workflow design in
`.harness/docs/agent/design-conformance-report.md`.
Each reported mismatch must cite both code and design paths. Without sufficient
design evidence or completed LLM analysis, the report records the scope as not
assessed instead of claiming conformance.

Existing canonical design files are preserved. `--force` may refresh only files
that still contain the harness reverse-engineering marker; it does not overwrite
unmarked user-authored design documents.

Bootstrap is documentation-only. Additional prompt text is treated as evidence
for requirements or design reconstruction and never authorizes product code,
tests, migrations, build files, deployment files, scripts, or runtime
configuration changes. Implementation requires a separate workflow invocation.

`harness requirements-definition` runs this bootstrap when it creates the initial
ChangeSet state.

## 2. Purpose

This document defines the ChangeSet and use-case slice based execution structure.
The goal is to make each implementation request state its change intent and impact,
and to keep planner/executor inputs bounded to approved use-case scope instead of
re-analyzing all of `docs/design/**` every time.

## 3. Standard Structure

```text
docs/
  changes/
    active/
      CHG-YYYYMMDD-NNN.md
    completed/
      CHG-YYYYMMDD-NNN.md

  use-cases/
    UC-001/
      index.md
      use-case.md
      event-storming.md
      ddd-design.md
      technical-decisions.md
      e2e-goal.md

  maintenance/
    MAINT-001/
      index.md
      change-intent.md
      technical-decisions.md
      verification-goal.md

  plans/
    active/
      UC-001/
        plan.md
        verification.md
    completed/
      UC-001/
        plan.md
        verification.md

  templates/
    changes/
      change-set.md
    use-cases/
      index.md
      use-case.md
      event-storming.md
      ddd-design.md
      technical-decisions.md
      e2e-goal.md
    plans/
      verification.md
```

`.harness/docs/templates/**` contains the source templates copied for new documents.
`docs/changes/active`, `docs/changes/completed`, `docs/plans/active`,
and `docs/plans/completed` represent real execution state.

## 4. ChangeSet Rules

Each ChangeSet represents one implementation request or documentation change request.
Every ChangeSet must include:

- Intent before and after the change (`Before` / `After`)
- Changed document list
- Affected work item list (`use_case`, `maintenance`)
- Whether each use case changes its E2E goal
- Whether each maintenance item changes its verification goal
- Input scope for planner/executor
- Explicitly excluded scope

Create new changes under `docs/changes/active/<CHG-ID>.md`.
After all affected use-case plans are complete and verification passes, move the same
file to `docs/changes/completed/<CHG-ID>.md`.

## 5. Use-Case Slice Rules

`docs/use-cases/<UC-ID>/` is an executor-facing document set that narrows a specific
use case into an implementable unit.

- `index.md`: slice document state, approval state, and trace links
- `use-case.md`: actor goal, preconditions, main/exception flows, and outcomes
- `event-storming.md`: command/event/policy/system slice required by the UC
- `ddd-design.md`: domain, aggregate, service, and bounded-context decisions required by the UC
- `technical-decisions.md`: detailed technical decisions required by the UC
- `docs/use-cases/<UC-ID>/e2e-goal.md`: pre-implementation business acceptance contract,
  including observable success/failure criteria and Given/When/Then

When a use-case slice exists, planner and executor use documents from that directory
first. They reference `docs/design/**` only as supporting input when shared design is
needed.

## 6. Maintenance Slice Rules

`docs/maintenance/<MAINT-ID>/` is an executor-facing document set that narrows
maintenance work into an executable unit when the work does not fit a specific use
case, such as refactoring, bug fixes, test hardening, infrastructure changes, or docs
cleanup.

Maintenance IDs use the `MAINT-` prefix and three digits, such as `MAINT-001`.
One ChangeSet can list use-case slices and maintenance slices together; planner and
executor follow the work item order in the ChangeSet.

- `index.md`: maintenance slice state, related ChangeSet, and document list
- `change-intent.md`: change intent, background, Before/After, included/excluded scope
- `technical-decisions.md`: implementation decisions and deferred decisions when needed
- `verification-goal.md`: completion criteria and verification commands

Create new maintenance slices under `docs/maintenance/<MAINT-ID>/`.
Required documents are `docs/maintenance/<MAINT-ID>/change-intent.md`,
and `docs/maintenance/<MAINT-ID>/verification-goal.md`.
Use `docs/maintenance/<MAINT-ID>/technical-decisions.md` only when implementation
decisions are needed.

Maintenance slices do not require event storming or a UC E2E goal.
Instead, `verification-goal.md` is the standard for implementation completion and
merge readiness. Create the plan at `docs/plans/active/<MAINT-ID>/plan.md`, then move
it to `docs/plans/completed/<MAINT-ID>/plan.md` after completion.

## 7. Canonical Design Relationship

`docs/design/**` is the product/domain-level canonical document set.
`docs/use-cases/<UC-ID>/**` is the slice document set for a specific use-case
execution. `docs/maintenance/<MAINT-ID>/**` does not directly replace canonical docs;
it records only the execution scope and verification criteria required for a specific
maintenance change.

- Canonical documents are the source of truth for the whole product.
- UC slices narrow the relevant canonical content and ChangeSet delta into an
  executable form.
- Maintenance slices state the need in the ChangeSet when canonical changes are
  required; they do not make unapproved canonical document changes.
- If slice and canonical documents conflict, the executor loop must not resolve that
  conflict ad hoc. Classify it as `DOCUMENT_DELTA_CONFLICT` or
  `UPSTREAM_DESIGN_CONFLICT` and return to the upstream document revision stage.
- The full `docs/design/이벤트 스토밍.md` can remain as a summary/index, but direct
  input for UC implementation planning is `docs/use-cases/<UC-ID>/event-storming.md`.

## 8. Plan Movement Rules

Create use-case plans at `docs/plans/active/<UC-ID>/plan.md`.
Create maintenance plans at `docs/plans/active/<MAINT-ID>/plan.md`.
Verification evidence can be recorded in the same directory as `verification.md`.
For use-case work, keep `e2e-goal.md` stable after approval and record implementation-specific
test suite details, fixtures, request/response examples, UI steps, commands, and actual pass/fail
evidence in `docs/plans/active/<UC-ID>/verification.md` or the plan verification result.

Move plans to completed only when all of these conditions are met:

- Every checkbox in `plan.md` is complete
- Success criteria in `docs/use-cases/<UC-ID>/e2e-goal.md` or
  `docs/maintenance/<MAINT-ID>/verification-goal.md` are satisfied
- Every required repository test-gate stage passes
- Verification results are recorded in `plan.md` or `verification.md`

Move completed UC plans to `docs/plans/completed/<UC-ID>/plan.md`.
Move completed maintenance plans to `docs/plans/completed/<MAINT-ID>/plan.md`.
Keep incomplete, failed, or blocked plans under active.

Classify verification failures by work item type as `implementation failure`,
`scope conflict`, `environment blocker`, or `verification goal unclear`.

## 9. Runtime CLI

The local runtime reads work items under a ChangeSet and stores execution state under
`.harness/runs/<run-id>/`.

```bash
./harness changes list
./harness changes show <CHG-ID>
./harness requirements-definition <CHG-ID>
./harness ubiquitous-language-definition <CHG-ID>
./harness use-case-definition <CHG-ID>
./harness event-storming <CHG-ID> --uc <UC-ID>
./harness ddd-architecture-definition <CHG-ID> --uc <UC-ID>
./harness technical-decisions <CHG-ID> --uc <UC-ID>
./harness plan-writing <CHG-ID> --uc <UC-ID> --plan|--preview|--apply
./harness implementation <CHG-ID> --plan|--preview|--apply
./harness stages list <CHG-ID>
./harness artifacts show <CHG-ID> <stage>
./harness artifacts accept <CHG-ID> <stage>
./harness resume <run-id>
./harness report <run-id>
./harness dashboard
```

`--plan` and `--preview` show scope and ordering without file changes or external
commands. `--apply` runs the selected stage and writes state/report/dashboard
projections.

## 10. Codex Prompt Prefix And Runtime Artifacts

OpenAI/Codex call cost optimization is based on **prompt prefix reuse**, not response
caching. The runtime always assembles agent prompts in the same section order.

```text
[stable] Runtime Instruction
[stable] Repository Source of Truth
[stable] Agent Instruction
[stable] Skill Body
[stable] Workflow Definition
[stable-ish] Repository Settings
[volatile] ChangeSet Summary
[volatile] Work Item Slice
[volatile] Current Execution Payload
```

Rules:

- Stable sections always come before ChangeSet, work item, run ID, and logs.
- Keep section headers even when optional documents are missing, and record `<not found>`.
- File traversal uses a sorted fixed order.
- Do not place run ID, temporary paths, verifier output, diffs, or logs before the stable prefix.

For agent calls, the runtime records both step-local files and run-root snapshots.

```text
.harness/runs/<RUN-ID>/
  prompt-<STEP-ID>.md
  response-<STEP-ID>.json
  stdout-<STEP-ID>.log
  stderr-<STEP-ID>.log
  usage-<STEP-ID>.json
  steps/<STEP-ID>/
    prompt.md
    command.json
    stdout.txt
    stderr.txt
    final-message.md
    result.json
```

`usage-<STEP-ID>.json` stores token values when the provider returns usage metadata.
For values that are not exposed, such as `cached_prompt_tokens`, leave them as `null`
instead of estimating. These runtime artifacts are execution evidence for reproduction,
resume, audit, and debugging; they are not the source of truth.
