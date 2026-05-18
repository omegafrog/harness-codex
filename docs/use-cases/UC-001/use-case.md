# UC-001. End User Calculates an Arithmetic Expression

## 1. Overview

- Actor: End user.
- Supporting actor: None.
- Goal: End user calculates an arithmetic expression and sees either a numeric result or `ERROR`.
- Related ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- Canonical source: `docs/design/유스케이스.md`

## 2. Preconditions

- The calculator page loaded successfully.
- The current page session is active in a supported desktop browser.
- The user has entered an expression with keyboard input, on-screen buttons, or both.

## 3. Basic Flow

1. The user enters numbers, operators, decimal points, and parentheses by keyboard, on-screen buttons, or both.
2. The user triggers `=` or `Calculate`.
3. The system evaluates the full expression with operator precedence.
4. If evaluation succeeds, the system formats the result.
5. The system shows the numeric result.

## 4. Exception Flow

|Condition|System Response|User / External Observation|
|---|---|---|
|Invalid operation|Display `ERROR`.|The user sees `ERROR`.|
|Syntactically invalid or incomplete expression|Display `ERROR` without auto-correction.|The user sees `ERROR`.|

## 5. Outcomes

### Success Outcomes

- The user sees the evaluated numeric result.
- Long decimal output is displayed using 10 decimal places.

### Failure Outcomes

- Invalid or incomplete input displays `ERROR`.

## 6. Non-Functional Requirements

|Area|Requirement|Decision Status|
|---|---|---|
|Performance|Evaluation and result display complete within 1 second after explicit calculation.|confirmed|
|Consistency|Calculation state remains in browser memory only for the current page session.|confirmed|
|Security / Authorization|No login, access control, backend calls, or third-party calculation calls are used.|confirmed|
|Operations|Unexpected runtime failures are observable through browser-console error logging only.|confirmed|

## 7. Scope

### Included

- Implement behavior needed for canonical `UC-01`.

### Excluded

- Behavior from use cases not listed in the active ChangeSet.

## 8. Canonical Alignment

- Canonical source: `docs/design/유스케이스.md`
- Canonical use case: `UC-01. End user calculates an arithmetic expression.`
- This slice must stay aligned to frontend-only calculation behavior and must not reintroduce CLI, undo, or latest-result continuation scope.
