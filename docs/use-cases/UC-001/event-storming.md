# UC-001. Note Author opens a Markdown Note from the Note Explorer event storming

## 1. Overview
- Input ChangeSet: `docs/changes/active/CHG-20260526-001.md`
- Input use case: `docs/use-cases/UC-001/use-case.md`
- Input E2E goal: `docs/use-cases/UC-001/e2e-goal.md`
- Canonical summary/index: `docs/design/이벤트 스토밍.md` (not present)
- Output purpose: derive the events, policies, commands, systems, external systems, and invariants required to implement the affected UC from its initial command.

## 2. Legend
| Type | Meaning | Writing rule |
| --- | --- | --- |
| 🟦 Command | Instruction for the system to perform an action | Write in imperative form |
| 🟧 Event | Fact that happened in the domain | Write in past tense |
| 🟪 Policy | Rule that decides the next action after an event | Write as a condition or decision criterion |
| ⬛ System | Owner of commands, events, and policies | Write as a domain or system name |
| 🟩 External system | Collaborating system outside the domain boundary | Write as an external system name |

## 3. Starting use case
- Use case: `UC-001. Note Author opens a Markdown Note from the Note Explorer`
- Actor: `Note Author`
- Goal: open one selected `Markdown Note` from the tree-shaped `Note Explorer` into the existing `Editor Pane`
- Initial command: 🟦 `Expand selected Note Folder`

### Preconditions
- The system uses the fixed `notes/` directory beneath the project root as the `Note Workspace`.
- The left side panel displays the `Note Explorer`.
- The `Note Explorer` shows visible `Note Folder` and `.md` `Markdown Note` entries beneath the `Note Workspace`.
- The application's existing unsaved-change behavior is available for `Open Markdown Note`.

### Postconditions
- Success: the selected `Markdown Note` is displayed in the existing `Editor Pane` as `Opened Markdown Note`.
- Failure: `Markdown Note Open Failure` is produced, the current `Editor Pane` content stays unchanged, and an error message is displayed to the `Note Author`.

## 4. Flows
### [Flow: Basic flow]
🟦 `Expand selected Note Folder`
→ 🟧 `Note Folder expansion was requested`
→ 🟪 `If the selected item is a Note Folder`
→ 🟧 `Visible child Note Explorer entries were displayed`
→ 🟦 `Open selected Markdown Note`
→ 🟧 `Markdown Note open was requested`
→ 🟪 `If the selected item is a visible Markdown Note`
→ 🟧 `Existing unsaved-change behavior was applied`
→ 🟪 `If the existing unsaved-change behavior allows note opening`
→ 🟧 `Opened Markdown Note content was displayed in the Editor Pane`

---
### [Flow: Exception flow]
🟦 `Open selected Markdown Note`
→ 🟧 `Markdown Note open was requested`
→ 🟪 `If the selected item is not a visible Markdown Note`
→ 🟧 `Markdown Note open was skipped`

🟦 `Open selected Markdown Note`
→ 🟧 `Markdown Note open was requested`
→ 🟪 `If Markdown Note opening fails`
→ 🟧 `Markdown Note open failure was produced`
→ 🟦 `Preserve current Editor Pane content`
→ 🟧 `Current Editor Pane content was preserved`
→ 🟧 `Error message was displayed to the Note Author`

---
## 5. Domain elements
| Type | Content | Trigger | Result | System | Note |
| --- | --- | --- | --- | --- | --- |
| 🟦 | `Expand selected Note Folder` | `Note Author` selects a `Note Folder` | `Note Folder expansion was requested` | `Note Explorer` | Initial command from the first actor action |
| 🟧 | `Note Folder expansion was requested` | `Expand selected Note Folder` | `If the selected item is a Note Folder` | `Note Explorer` | Folder expansion request entered the domain flow |
| 🟪 | `Check if the selected item is a Note Folder` | `Note Folder expansion was requested` | `Visible child Note Explorer entries were displayed` | `Note Explorer` | Allows expansion only for folder selections |
| 🟧 | `Visible child Note Explorer entries were displayed` | `If the selected item is a Note Folder` | `Open selected Markdown Note` | `Note Explorer` | Child `Note Folder` and `.md` entries become visible |
| 🟦 | `Open selected Markdown Note` | `Note Author` selects a visible `Markdown Note` | `Markdown Note open was requested` | `Markdown Note Opening` | Reuses the existing `Editor Pane` |
| 🟧 | `Markdown Note open was requested` | `Open selected Markdown Note` | `If the selected item is a visible Markdown Note` | `Markdown Note Opening` | Open request entered the domain flow |
| 🟪 | `If the selected item is a visible Markdown Note` | `Markdown Note open was requested` | `Existing unsaved-change behavior was applied` | `Markdown Note Opening` | Rejects non-Markdown and hidden selections |
| 🟧 | `Existing unsaved-change behavior was applied` | `If the selected item is a visible Markdown Note` | `If the existing unsaved-change behavior allows note opening` | `Markdown Note Opening` | Existing application policy gate before content replacement |
| 🟪 | `If the existing unsaved-change behavior allows note opening` | `Existing unsaved-change behavior was applied` | `Opened Markdown Note content was displayed in the Editor Pane` | `Markdown Note Opening` | Allows the selected note to replace current editor content |
| 🟧 | `Opened Markdown Note content was displayed in the Editor Pane` | `If the existing unsaved-change behavior allows note opening` | none | `Editor Pane` | Success result |
| 🟪 | `If the selected item is not a visible Markdown Note` | `Markdown Note open was requested` | `Markdown Note open was skipped` | `Markdown Note Opening` | Failure branch from invalid selection |
| 🟧 | `Markdown Note open was skipped` | `If the selected item is not a visible Markdown Note` | none | `Markdown Note Opening` | No open action occurs for invalid selections |
| 🟪 | `If Markdown Note opening fails` | `Markdown Note open was requested` | `Markdown Note open failure was produced` | `Markdown Note Opening` | Failure branch from note-open error |
| 🟧 | `Markdown Note open failure was produced` | `If Markdown Note opening fails` | `Preserve current Editor Pane content` | `Markdown Note Opening` | Failure outcome defined by the use case |
| 🟦 | `Preserve current Editor Pane content` | `Markdown Note open failure was produced` | `Current Editor Pane content was preserved` | `Editor Pane` | Protects current editor state on failure |
| 🟧 | `Current Editor Pane content was preserved` | `Preserve current Editor Pane content` | `Error message was displayed to the Note Author` | `Editor Pane` | Existing content remains unchanged |
| 🟧 | `Error message was displayed to the Note Author` | `Markdown Note open failure was produced` | none | `Note Explorer` | User-visible error feedback |

---
## 6. External systems
| System | Integration purpose | Related use case | Note |
| --- | --- | --- | --- |
| `None` | `None` | `UC-001` | `None` |

---
## 7. Invariants
- The `Note Explorer` must show only visible `Note Folder` entries and visible `.md` `Markdown Note` entries beneath the fixed `notes/` workspace.
- Only a visible `Markdown Note` selection can proceed to `Open selected Markdown Note`.
- The existing unsaved-change behavior must run before selected note content replaces the current `Editor Pane` content.
- `Markdown Note Open Failure` must preserve the current `Editor Pane` content unchanged.
- A successfully opened `Markdown Note` must appear in the single existing `Editor Pane`.

## 8. UC domain element summary
### 8.1 Commands
| Command | Source use case | System |
| --- | --- | --- |
| `Expand selected Note Folder` | `UC-001` | `Note Explorer` |
| `Open selected Markdown Note` | `UC-001` | `Markdown Note Opening` |
| `Preserve current Editor Pane content` | `UC-001` | `Editor Pane` |

### 8.2 Events
| Event | Source use case | System |
| --- | --- | --- |
| `Note Folder expansion was requested` | `UC-001` | `Note Explorer` |
| `Visible child Note Explorer entries were displayed` | `UC-001` | `Note Explorer` |
| `Markdown Note open was requested` | `UC-001` | `Markdown Note Opening` |
| `Existing unsaved-change behavior was applied` | `UC-001` | `Markdown Note Opening` |
| `Opened Markdown Note content was displayed in the Editor Pane` | `UC-001` | `Editor Pane` |
| `Markdown Note open was skipped` | `UC-001` | `Markdown Note Opening` |
| `Markdown Note open failure was produced` | `UC-001` | `Markdown Note Opening` |
| `Current Editor Pane content was preserved` | `UC-001` | `Editor Pane` |
| `Error message was displayed to the Note Author` | `UC-001` | `Note Explorer` |

### 8.3 Policies
| Policy | Trigger event | Result | System |
| --- | --- | --- | --- |
| `If the selected item is a Note Folder` | `Note Folder expansion was requested` | `Visible child Note Explorer entries were displayed` | `Note Explorer` |
| `If the selected item is a visible Markdown Note` | `Markdown Note open was requested` | `Existing unsaved-change behavior was applied` | `Markdown Note Opening` |
| `If the existing unsaved-change behavior allows note opening` | `Existing unsaved-change behavior was applied` | `Opened Markdown Note content was displayed in the Editor Pane` | `Markdown Note Opening` |
| `If the selected item is not a visible Markdown Note` | `Markdown Note open was requested` | `Markdown Note open was skipped` | `Markdown Note Opening` |
| `If Markdown Note opening fails` | `Markdown Note open was requested` | `Markdown Note open failure was produced` | `Markdown Note Opening` |

### 8.4 External systems
| External system | Related use case | Integration purpose |
| --- | --- | --- |
| `None` | `UC-001` | `None` |

## 9. Canonical summary/index update
- Need for a summary/index update in `docs/design/이벤트 스토밍.md`: no current update because the canonical summary/index file is not present.
- Link or summary to add: `None`

## 10. Needs confirmation
- `None`
