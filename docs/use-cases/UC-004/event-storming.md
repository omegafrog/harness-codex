# UC-004. End User Retries Calculator Use After an App Failure Event Storming

## 1. Overview
- Input ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- Input use case: `docs/use-cases/UC-004/use-case.md`
- Input E2E goal: `docs/use-cases/UC-004/e2e-goal.md`
- Canonical summary/index: `docs/design/이벤트 스토밍.md`
- Output purpose: Use the affected UC as the initial command and extract the events, policies, commands, systems, external systems, and rules needed to implement this UC.

## 2. Legend
|Type|Meaning|Writing rule|
|---|---|---|
|🟦 Command|An instruction that tells the system to perform an action|Write in imperative form|
|🟧 Event|A fact that happened in the domain|Write in past tense|
|🟪 Policy|A rule that decides the next action after an event|Write as a condition and decision|
|⬛ System|The owner of commands, events, and policies|Write as a domain or system name|
|🟩 External system|A collaborating system outside the domain boundary|Write as the external system name|

## 3. Starting Use Case
- Use case: `UC-004`. End User Retries Calculator Use After an App Failure
- Actor: End user
- Goal: Retry access to the calculator after the app fails to load or run
- Initial command: 🟦 Reload the calculator app

### Preconditions
- The calculator app failed to load or run.
- The failure state is visible to the user.

### Exit Conditions
- Success: The calculator app is available again in the empty calculator state.
- Failure: The failure state is shown again until a later manual refresh succeeds.

## 4. Flows
### [Flow: Basic Flow]
🟦 Reload the calculator app
→ 🟧 Calculator app reload was requested
→ 🟪 App loading succeeds
→ 🟧 Empty calculator state was shown

---
### [Flow: Exception Flow]
🟦 Reload the calculator app
→ 🟧 Calculator app reload was requested
→ 🟪 App loading fails
→ 🟧 Failure state was shown again

---
## 5. Domain Elements (Unified)
|Type|Content|Trigger|Result|System|Notes|
|---|---|---|---|---|---|
|🟦|Reload the calculator app|End user|Calculator app reload was requested|Calculator app lifecycle|Manual browser refresh only|
|🟧|Calculator app reload was requested|Reload the calculator app|App loading succeeds; App loading fails|Calculator app lifecycle|Represents a new app-load attempt|
|🟪|App loading succeeds|Calculator app reload was requested|Empty calculator state was shown|Calculator app lifecycle|Recovered session starts empty|
|🟪|App loading fails|Calculator app reload was requested|Failure state was shown again|Calculator app lifecycle|No automatic retry path|
|🟧|Empty calculator state was shown|App loading succeeds|Use case completes successfully|Calculator UI|Ready for new calculator input|
|🟧|Failure state was shown again|App loading fails|User may retry later with another manual refresh|Calculator UI|Failure remains visible|

---
## 6. External Systems
|System|Integration purpose|Related use case|Notes|
|---|---|---|---|
|None|None|`UC-004`|None|

---
## 7. Rules (Invariant)
- Recovery can start only after the end user manually refreshes the page.
- A successful recovery always shows the empty in-memory calculator state.
- A failed recovery always shows the failure state again.
- This UC never performs automatic retry, saved-state restore, backend recovery, or third-party recovery.

## 8. UC Domain Element Summary
### 8.1 Commands
|Command|Source use case|System|
|---|---|---|
|Reload the calculator app|`UC-004`|Calculator app lifecycle|

### 8.2 Events
|Event|Source use case|System|
|---|---|---|
|Calculator app reload was requested|`UC-004`|Calculator app lifecycle|
|Empty calculator state was shown|`UC-004`|Calculator UI|
|Failure state was shown again|`UC-004`|Calculator UI|

### 8.3 Policies
|Policy|Trigger event|Result|System|
|---|---|---|---|
|App loading succeeds|Calculator app reload was requested|Empty calculator state was shown|Calculator app lifecycle|
|App loading fails|Calculator app reload was requested|Failure state was shown again|Calculator app lifecycle|

### 8.4 External Systems
|External system|Related use case|Integration purpose|
|---|---|---|
|None|`UC-004`|None|

## 9. Canonical Summary/Index Update
- Need summary/index update in `docs/design/이벤트 스토밍.md`: No
- Link or summary to add: The canonical summary/index file does not exist.

## 10. Need Confirmation
- None.
