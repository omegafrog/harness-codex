---
name: harness-ultrawork
description: Create a ChangeSet and run affected harness workflows through `harness ultrawork`. Use when the user asks to run ultrawork, start an end-to-end ChangeSet workflow from a title or idea, preview affected workflow execution, or apply the runtime orchestration command.
---

# Harness Ultrawork

## Command Map

- `./harness ultrawork [--title TEXT] [--change-set-id ID] [--uc UC-ID] [--force] [--plan|--preview|--apply]`

## Procedure

1. Use `./harness help ultrawork` when exact current flags matter.
2. Prefer `--preview` unless the user explicitly requests applying workflow execution.
3. After execution, report ChangeSet ID, affected use cases, generated artifacts, and resume/report command.
4. Preserve stage approvals; do not bypass required artifact acceptance.

For fully agent-led orchestration without relying only on the runtime command, use `harness-full-workflow` or `harness-post-harvest-orchestrator`.
