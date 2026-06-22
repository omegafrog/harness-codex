---
name: harness-ultrawork
description: Compatibility guidance for the retired ultrawork entry point. Translate requests into the canonical harvest, ChangeSet, and runtime commands without retaining workflow state.
---

# Harness Ultrawork Compatibility Wrapper

`ultrawork` is no longer an orchestration command. Translate it into the
canonical runtime sequence:

```bash
./harness harvest --idea "<request>" --apply --session-id harvest-001
./harness changes create-from-design --title "<title>" --related-issue "#<issue>"
./harness run-change CHG-YYYYMMDD-001 --apply
```

Use `run-work-item` or `run-use-case` only when the caller explicitly narrows
the execution scope.

## State Rule

Do not create a parallel ultrawork state, procedure table, or wrapper
completion flag. Read `.harness/runs/<RUN-ID>/state.json` and use `resume` or
`report` to communicate the next runtime action.

This compatibility skill and its migration instructions end on 2026-09-30. See
`docs/architecture/legacy-command-migration.md`.
