# UC-002. End User Edits the Current Expression

## 1. Overview

- Actor: End user.
- Supporting actor: None.
- Goal: End user edits the current expression before the next calculation.
- Related ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- Canonical source: `docs/design/유스케이스.md`

## 2. Preconditions

- The calculator page loaded successfully.
- The current page session is active in a supported desktop browser.

## 3. Basic Flow

1. The user enters or changes characters in the current expression by keyboard input, on-screen buttons, or both.
2. The user may trigger a single-character delete or backspace action.
3. The system updates the current expression immediately.
4. If an old result is visible and the expression changes, the system clears the old result immediately.

## 4. Exception Flow

|Condition|System Response|User / External Observation|
|---|---|---|
|Expression becomes invalid or incomplete while editing|Keep the edited expression as entered without auto-correction.|The user sees the current edited expression and no stale result.|

## 5. Outcomes

### Success Outcomes

- The system shows the updated current expression.
- Any previously shown result is cleared when the expression changes.

### Failure Outcomes

- The system does not auto-correct invalid or incomplete expression text during editing.

## 6. Non-Functional Requirements

|Area|Requirement|Decision Status|
|---|---|---|
|Performance|Expression updates appear immediately during normal desktop-browser interaction.|confirmed|
|Consistency|Edited expression state remains in browser memory only for the current page session.|confirmed|
|Security / Authorization|No login, access control, backend calls, or third-party calculation calls are used.|confirmed|
|Operations|Unexpected runtime failures are observable through browser-console error logging only.|confirmed|

## 7. Scope

### Included

- Implement behavior needed for canonical `UC-02`.

### Excluded

- Behavior from use cases not listed in the active ChangeSet.

## 8. Canonical Alignment

- Canonical source: `docs/design/유스케이스.md`
- Canonical use case: `UC-02. End user edits the current expression.`
- This slice must stay aligned to frontend-only expression editing behavior and must not reintroduce latest-result continuation scope.
