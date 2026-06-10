# harness-plan-executor Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-plan-executor/SKILL.md`

## Purpose

Execute exactly one ChangeSet work-item plan:

- UC: `docs/plans/active/<UC-ID>/plan.md`
- Maintenance: `docs/plans/active/<MAINT-ID>/plan.md`
- Generic contract: `docs/plans/active/<WORK-ITEM-ID>/plan.md`

The runtime payload must provide the active ChangeSet ID, work-item ID, work-item
type, active plan path, and verification goal path. Never use an unscoped
root-level active plan.

Delegate implementation to `implementation_executor`. This skill owns final
verification, remediation classification, and moving only the targeted plan.

## Work-Item Inputs

Always required:

- `docs/changes/active/<CHG-ID>.md`
- `docs/plans/active/<WORK-ITEM-ID>/plan.md`
- `ARCHITECTURE.md`
- `.codex/repository-settings.md`
- `.codex/test-gate.yaml`

UC work item:

- `docs/use-cases/<UC-ID>/**`
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- verification evidence: `docs/plans/active/<UC-ID>/verification.md`

Maintenance work item:

- `docs/maintenance/<MAINT-ID>/change-intent.md`
- `docs/maintenance/<MAINT-ID>/affected-files.md`
- `docs/maintenance/<MAINT-ID>/verification-goal.md`
- optional `docs/maintenance/<MAINT-ID>/technical-decisions.md`
- verification evidence: `docs/plans/active/<MAINT-ID>/verification.md`

Generic evidence path: `docs/plans/active/<WORK-ITEM-ID>/verification.md`.

Stop when the selected plan, ChangeSet, work-item slice, verification goal,
architecture, repository settings, or test gate is missing. Do not infer another
active plan when multiple work-item plans exist.

## Scope Rules

- Execute only unchecked tasks in the targeted work-item plan.
- Do not execute or complete other active work-item plans.
- Do not add features or maintenance changes outside the targeted plan and
  ChangeSet.
- Do not change approved UC E2E goals or maintenance verification goals.
- Preserve unrelated user changes.
- Use the work-item slice affected-files boundary when present.
- Record implementation evidence in the targeted work item's `verification.md`.

## Execution

1. Resolve `<WORK-ITEM-ID>` and type from runtime payload.
2. Read the targeted plan, ChangeSet, matching work-item slice, verification
   goal, architecture, repository settings, and test gate.
3. Confirm plan ID/type/path match the runtime payload.
4. Invoke `implementation_executor` for unchecked tasks in that plan only.
5. Require QA Inspector evidence after UI/runtime/dashboard boundary changes.
6. Run final build, tests, test gate, runtime verification, and static analysis.
7. For UC, verify `e2e-goal.md`.
8. For maintenance, verify `verification-goal.md`.
9. Record commands and evidence in the targeted plan and `verification.md`.
10. Move only the targeted plan after every completion gate passes:

```text
docs/plans/active/<WORK-ITEM-ID>/plan.md -> docs/plans/completed/<WORK-ITEM-ID>/plan.md
```

## Failure Classification

- `IMPLEMENTATION_FAILURE`: code/test/config inside approved scope is wrong.
- `UNCLEAR_E2E_GOAL`: UC E2E contract is missing or untestable.
- `VERIFICATION_GOAL_UNCLEAR`: maintenance verification contract is missing or
  untestable.
- `DOCUMENT_DELTA_CONFLICT`: plan, slice, and ChangeSet disagree.
- `UPSTREAM_DESIGN_CONFLICT`: approved design or architecture must change.
- `ENVIRONMENT_BLOCKER`: external environment prevents execution.
- `SCOPE_CONFLICT`: required edit is outside approved affected-files or
  ChangeSet scope.

Only for `IMPLEMENTATION_FAILURE`, add remediation tasks. Keep the targeted plan
active for every failure. Stop and report all other classifications.

## Completion Gates

Move the plan only when all are true:

- Every checkbox is checked.
- Required implementation and tests exist.
- Build and tests pass.
- UC E2E or maintenance verification goal passes.
- `.codex/test-gate.yaml` required stages pass.
- Runtime server verification passes or is explicitly not applicable.
- Static analysis passes.
- Concrete evidence paths and results are recorded.

Typical commands come from repository settings. Common examples:

```bash
./gradlew build
./gradlew test
./gradlew e2eTest
./gradlew architectureRules
semgrep --config .semgrep/ddd-architecture.yml .
```

For browser-visible behavior, use Playwright from the end-user perspective.
API-only probes do not complete a browser E2E goal. For maintenance without a
browser surface, use the concrete verification path defined in
`verification-goal.md`.
