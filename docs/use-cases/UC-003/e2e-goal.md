# UC-003. End User Clears the Calculator State E2E Goal

## 1. Metadata

|Item|Value|
|---|---|
|UC ID|`UC-003`|
|Related ChangeSet|`docs/changes/active/CHG-20260507-001.md`|
|Approval Status|approved|
|Verification Command|Repository-specific test command|

## 2. Goal

- User-observable result: The user can reset the calculator to an empty state.
- System completion condition: The implementation clears the current expression and current result in response to `Clear`.

## 3. Given / When / Then

### Given

- The calculator page is loaded in a supported desktop browser.
- A current expression, current result, or both may be present.

### When

- The user triggers `Clear`.

### Then

- The current expression is removed.
- The current result is removed.
- The empty calculator state is shown.

## 4. Success Criteria

- Clear behavior passes through the user-visible interface.
- Repeated clear behavior is covered by tests.

## 5. Failure Criteria

- The implementation leaves expression or result state behind after `Clear`.
- The implementation fails to show the empty state after `Clear`.

## 6. Verification Method

|Step|Command|Success Criteria|Required|
|---|---|---|---|
|Repository test gate|Project-specific command from the implementation plan|Exit code 0|required|
|Use-case E2E|Project-specific E2E command when available|Given/When/Then is satisfied|required when E2E exists|

## 7. Observation Evidence

|Evidence|Record Location|
|---|---|
|Test log|`docs/plans/active/UC-003/verification.md`|
|Application observation|`docs/plans/active/UC-003/verification.md`|
|Blocker reason|`docs/plans/active/UC-003/plan.md` or `verification.md`|

## 8. Confirmation Needed

- Approve or refine this E2E goal before implementation planning.
