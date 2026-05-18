# UC-004. End User Retries Calculator Use After an App Failure

## 1. Overview

- Actor: End user.
- Supporting actor: None.
- Goal: End user retries access to the calculator after the app fails to load or run.
- Related ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- Canonical source: `docs/design/유스케이스.md`

## 2. Preconditions

- The app failed to load or the browser could not run the calculator logic.
- The system showed a simple failure state.

## 3. Basic Flow

1. The user sees the failure state.
2. The user refreshes the page manually.
3. The system attempts to load the calculator again.
4. If loading succeeds, the system shows the empty calculator state.

## 4. Exception Flow

|Condition|System Response|User / External Observation|
|---|---|---|
|Refresh does not recover the app|Show the failure state again.|The user still sees the failure state and must refresh again later.|

## 5. Outcomes

### Success Outcomes

- The user can use the calculator from an empty state.

### Failure Outcomes

- The failure state remains until a later successful manual refresh.

## 6. Non-Functional Requirements

|Area|Requirement|Decision Status|
|---|---|---|
|Performance|Recovery attempt begins immediately after manual page refresh.|confirmed|
|Consistency|Recovered state starts from an empty in-memory session.|confirmed|
|Security / Authorization|No login, access control, backend calls, or third-party recovery calls are used.|confirmed|
|Operations|Operational logging is limited to browser-console error logs for app-load failures and unexpected runtime exceptions.|confirmed|

## 7. Scope

### Included

- Implement behavior needed for canonical `UC-04`.

### Excluded

- Offline recovery, saved-state restore, retry automation, and backend-assisted recovery.

## 8. Canonical Alignment

- Canonical source: `docs/design/유스케이스.md`
- Canonical use case: `UC-04. End user retries calculator use after an app failure.`
- This slice must stay aligned to manual-refresh recovery only.
