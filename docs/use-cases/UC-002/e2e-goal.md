# UC-002. End User Edits the Current Expression E2E Goal

## 1. Metadata

|Item|Value|
|---|---|
|UC ID|`UC-002`|
|Related ChangeSet|`docs/changes/active/CHG-20260507-001.md`|
|Approval Status|approved|
|Verification Command|Repository-specific test command|

## 2. Goal

- User-observable result: The user can edit the current expression and the UI reflects the change immediately.
- System completion condition: The implementation supports direct editing, delete/backspace, and immediate stale-result clearing without auto-correcting invalid input.

## 3. Given / When / Then

### Given

- The calculator page is loaded in a supported desktop browser.
- A current expression exists or the user is entering one.

### When

- The user types, clicks buttons, or triggers delete/backspace to modify the current expression.

### Then

- The current expression updates immediately.
- Any previous result clears immediately after the expression changes.
- Invalid or incomplete intermediate text is not auto-corrected.

## 4. Success Criteria

- Keyboard and on-screen edit paths are covered through the user-visible interface.
- Stale-result clearing and no-auto-correct behavior are covered by tests.

## 5. Failure Criteria

- The implementation fails to update or delete expression text correctly.
- The implementation leaves a stale result visible after expression changes.

## 6. Verification Method

|Step|Command|Success Criteria|Required|
|---|---|---|---|
|Repository test gate|Project-specific command from the implementation plan|Exit code 0|required|
|Use-case E2E|Project-specific E2E command when available|Given/When/Then is satisfied|required when E2E exists|

## 7. Observation Evidence

|Evidence|Record Location|
|---|---|
|Test log|`docs/plans/active/UC-002/verification.md`|
|Application observation|`docs/plans/active/UC-002/verification.md`|
|Blocker reason|`docs/plans/active/UC-002/plan.md` or `verification.md`|

## 8. Confirmation Needed

- Approve or refine this E2E goal before implementation planning.
