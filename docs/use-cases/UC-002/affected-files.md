# UC-002. End User Edits the Current Expression Affected Files

## 1. Inputs

- ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- Use case: `docs/use-cases/UC-002/use-case.md`
- E2E goal: `docs/use-cases/UC-002/e2e-goal.md`

## 2. Expected Changed Files

|Path|Change Type|Reason|Verification Method|
|---|---|---|---|
|UI application source paths|create/update|Implement expression editing, delete/backspace, and stale-result clearing for `UC-02`|Repository test gate|

## 3. Expected Test Files

|Path|Test Target|Verification Rule|
|---|---|---|
|UI test paths|`UC-02` behavior|Editing and stale-result clearing behavior pass|

## 4. Documentation Files

|Path|Reason|Approval Required|
|---|---|---|
|`docs/use-cases/UC-002/...`|Use-case execution slice|yes|

## 5. Forbidden Files / Paths

|Path|Reason|
|---|---|
|`docs/use-cases/<other-UC-ID>/`|Outside the active ChangeSet scope|
|`docs/design/**`|Canonical changes require explicit ChangeSet approval|

## 6. Scope Boundary

### Included

- Files needed to implement and verify `UC-02`.

### Excluded

- Unaffected use-case docs and unrelated application behavior.

## 7. Confirmation Needed

- Replace broad application source and test path placeholders during implementation planning.
