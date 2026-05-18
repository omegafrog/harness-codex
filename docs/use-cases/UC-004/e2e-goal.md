# UC-004. End User Retries Calculator Use After an App Failure E2E Goal

## 1. Metadata

|Item|Value|
|---|---|
|UC ID|`UC-004`|
|Related ChangeSet|`docs/changes/active/CHG-20260507-001.md`|
|Approval Status|approved|
|Verification Command|Repository-specific test command|

## 2. Goal

- User-observable result: After an app-load or runtime failure, the user can retry by manually refreshing the page.
- System completion condition: A successful refresh returns the app to the empty calculator state, while an unsuccessful refresh shows the failure state again.

## 3. Given / When / Then

### Given

- The calculator app has entered its simple failure state.

### When

- The user refreshes the page manually.

### Then

- If the app loads successfully, the empty calculator state is shown.
- If the app still fails, the failure state is shown again.

## 4. Success Criteria

- Manual-refresh recovery behavior is covered through the user-visible interface or equivalent browser-level verification.
- Successful recovery returns the UI to the empty calculator state.

## 5. Failure Criteria

- The implementation cannot recover by manual refresh when the underlying failure is removed.
- The implementation leaves the UI in an inconsistent state after refresh.

## 6. Verification Method

|Step|Command|Success Criteria|Required|
|---|---|---|---|
|Repository test gate|Project-specific command from the implementation plan|Exit code 0|required|
|Use-case E2E|Project-specific E2E command when available|Given/When/Then is satisfied|required when E2E exists|

## 7. Observation Evidence

|Evidence|Record Location|
|---|---|
|Test log|`docs/plans/active/UC-004/verification.md`|
|Application observation|`docs/plans/active/UC-004/verification.md`|
|Blocker reason|`docs/plans/active/UC-004/plan.md` or `verification.md`|

## 8. Confirmation Needed

- Approve or refine this E2E goal before implementation planning.
