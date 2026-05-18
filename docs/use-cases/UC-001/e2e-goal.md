# UC-001. End User Calculates an Arithmetic Expression E2E Goal

## 1. Metadata

|Item|Value|
|---|---|
|UC ID|`UC-001`|
|Related ChangeSet|`docs/changes/active/CHG-20260507-001.md`|
|Approval Status|approved|
|Verification Command|Repository-specific test command|

## 2. Goal

- User-observable result: The user enters an arithmetic expression and sees either the correct numeric result or `ERROR`.
- System completion condition: The implementation evaluates full expressions with operator precedence, formats long decimal output to 10 decimal places, and rejects invalid or incomplete expressions with `ERROR`.

## 3. Given / When / Then

### Given

- The calculator page is loaded in a supported desktop browser.
- The user can enter an expression through keyboard input, on-screen buttons, or both.

### When

- The user enters a valid or invalid arithmetic expression and triggers `=` or `Calculate`.

### Then

- A valid full expression returns the expected numeric result.
- Long decimal output is shown with 10 decimal places.
- An invalid or incomplete expression returns `ERROR`.

## 4. Success Criteria

- UI-driven calculation passes for a valid full expression that uses operator precedence or parentheses.
- Invalid and incomplete expression handling is covered by tests.

## 5. Failure Criteria

- The implementation produces an incorrect result for a valid expression.
- The implementation fails to show `ERROR` for an invalid or incomplete expression.

## 6. Verification Method

|Step|Command|Success Criteria|Required|
|---|---|---|---|
|Repository test gate|Project-specific command from the implementation plan|Exit code 0|required|
|Use-case E2E|Project-specific E2E command when available|Given/When/Then is satisfied|required when E2E exists|

## 7. Observation Evidence

|Evidence|Record Location|
|---|---|
|Test log|`docs/plans/active/UC-001/verification.md`|
|Application observation|`docs/plans/active/UC-001/verification.md`|
|Blocker reason|`docs/plans/active/UC-001/plan.md` or `verification.md`|

## 8. Confirmation Needed

- Approve or refine this E2E goal before implementation planning.
