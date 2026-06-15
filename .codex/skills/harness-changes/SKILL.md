---
name: harness-changes
description: Operate harness ChangeSets through the runtime CLI. Use when the user asks to list, inspect, show contents, delete, continue, or document deltas for ChangeSets with `harness changes`.
---

# Harness Changes

## Command Map

- `./harness changes list`
- `./harness changes active`
- `./harness changes show <CHG-ID>`
- `./harness changes contents <CHG-ID>`
- `./harness changes continue <CHG-ID>`
- `./harness changes delete <CHG-ID>`
- `./harness changes document-delta <CHG-ID> --uc <UC-ID> --summary TEXT --plan|--preview|--apply`

## Procedure

1. Use `list` or `active` before ID-specific commands when the target is unclear.
2. For destructive deletion, show exact ChangeSet ID and affected path first, then require explicit user confirmation.
3. For `document-delta`, prefer `--preview` or `--plan` before `--apply` unless the user explicitly requested apply.
4. Summarize command output; do not paste long artifacts.
5. Preserve ChangeSet/use-case/work-item boundaries.
