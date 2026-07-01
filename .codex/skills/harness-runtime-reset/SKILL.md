---
name: harness-runtime-reset
description: Reset local harness runtime artifacts through `harness reset`. Use when the user asks to clear run state, workflow artifacts, sessions, checkpoints, dashboard UI state, or explicitly reset harness runtime data.
---

# Harness Runtime Reset

## Command Map

- `./harness reset --runs [--apply]`
- `./harness reset --workflow-artifacts [--apply]`
- `./harness reset --all [--apply]`

## Procedure

1. Read `.harness/docs/runtime/reset-command.md` when scope is unclear.
2. Run without `--apply` first to preview targets.
3. Before `--apply`, state exact scope and require explicit confirmation unless user already gave it.
4. Never use reset as part of update; update must preserve workflow artifacts.
5. After apply, run concise status checks and report removed target groups.
