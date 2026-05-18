# UC-001. End User Calculates an Arithmetic Expression Affected Files

## 1. Inputs

- ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- Use case: `docs/use-cases/UC-001/use-case.md`
- E2E goal: `docs/use-cases/UC-001/e2e-goal.md`

## 2. Expected Changed Files

|Path|Change Type|Reason|Verification Method|
|---|---|---|---|
|UI application source paths|create/update|Implement expression entry, explicit calculation, evaluation, formatting, and error display for `UC-01`|Repository test gate|

## 3. Expected Test Files

|Path|Test Target|Verification Rule|
|---|---|---|
|UI test paths|`UC-01` behavior|Valid-expression and invalid-expression behavior pass|

## 4. Documentation Files

|Path|Reason|Approval Required|
|---|---|---|
|`docs/use-cases/UC-001/...`|Use-case execution slice|yes|

## 5. Forbidden Files / Paths

|Path|Reason|
|---|---|
|`docs/use-cases/<other-UC-ID>/`|Outside the active ChangeSet scope|
|`docs/design/**`|Canonical changes require explicit ChangeSet approval|

## 6. Scope Boundary

### Included

- Files needed to implement and verify `UC-01`.

### Excluded

- Unaffected use-case docs and unrelated application behavior.

## 7. Confirmation Needed

- Replace broad application source and test path placeholders during implementation planning.
