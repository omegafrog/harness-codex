# UC-001 E2E Goal

## Metadata
| Item | Value |
| --- | --- |
| Approval Status | approved |
| Approved by | user-confirmed requirements and use-case harvest |

## Goal
- Verify that the `Note Author` can browse the tree-shaped `Note Explorer`, expand a `Note Folder`, select a visible `Markdown Note`, and see that selected content in the existing `Editor Pane`, while `Markdown Note Open Failure` preserves the current `Editor Pane` content and shows an error message.

## Given
- The system uses the fixed `notes/` directory beneath the project root as the `Note Workspace`.
- The left side panel displays the `Note Explorer`.
- The `Note Workspace` contains at least one visible `Note Folder` and one visible `.md` `Markdown Note`.
- The application has existing unsaved-change behavior available for `Open Markdown Note`.

## When
- The `Note Author` selects a `Note Folder` in the `Note Explorer`.
- The `Note Author` selects a visible `Markdown Note` from the expanded tree.
- The system is exercised with a scenario where `Open Markdown Note` cannot open the selected `Markdown Note`.

## Then
- The selected `Note Folder` expands and reveals its visible child `Note Folder` and `Markdown Note` entries.
- The `Note Explorer` hides non-Markdown files in the `Note Workspace`.
- The system performs `Open Markdown Note` in the single existing `Editor Pane`.
- On success, the system displays the selected `Markdown Note` content in the existing `Editor Pane` as `Opened Markdown Note`.
- On failure, the system produces `Markdown Note Open Failure`, preserves the current `Editor Pane` content unchanged, and displays an error message to the `Note Author`.

## Verification Notes
- Confirm that `docs/design/유스케이스.md` and `docs/use-cases/UC-001/use-case.md` use the same UC ID and title.
- Confirm that no stale fleeting-note terminology remains in the `UC-001` slice docs.
- Confirm that the success and failure outcomes match the approved requirements for `Open Markdown Note`.

## Needs Confirmation
- None
