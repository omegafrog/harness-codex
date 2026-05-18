# UC-003. End User Clears the Calculator State

## 1. Overview

- Actor: End user.
- Supporting actor: None.
- Goal: End user resets the current expression and current result.
- Related ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- Canonical source: `docs/design/유스케이스.md`

## 2. Preconditions

- The calculator page loaded successfully.
- The current page session is active in a supported desktop browser.

## 3. Basic Flow

1. The user triggers `Clear`.
2. The system removes the current expression.
3. The system removes the current result.
4. The system shows the empty calculator state.

## 4. Exception Flow

|Condition|System Response|User / External Observation|
|---|---|---|
|No current expression or result exists|Keep the calculator in the empty state.|The user still sees the empty calculator state.|

## 5. Outcomes

### Success Outcomes

- The calculator returns to an empty in-memory state for the current page session.

### Failure Outcomes

- Clear removes any current expression and current result regardless of the previous editing state.

## 6. Non-Functional Requirements

|Area|Requirement|Decision Status|
|---|---|---|
|Performance|Clear completes within normal interactive browser response time.|confirmed|
|Consistency|Cleared state is not stored beyond the current in-memory page session.|confirmed|
|Security / Authorization|No login, access control, backend calls, or third-party calculation calls are used.|confirmed|
|Operations|Unexpected runtime failures are observable through browser-console error logging only.|confirmed|

## 7. Scope

### Included

- Implement behavior needed for canonical `UC-03`.

### Excluded

- Behavior from use cases not listed in the active ChangeSet.

## 8. Canonical Alignment

- Canonical source: `docs/design/유스케이스.md`
- Canonical use case: `UC-03. End user clears the calculator state.`
- This slice must stay aligned to explicit clear behavior and must not reintroduce undo scope.
