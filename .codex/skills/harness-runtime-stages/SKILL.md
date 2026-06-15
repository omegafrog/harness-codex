---
name: harness-runtime-stages
description: Inspect runtime procedure stage artifacts through the harness CLI. Use when the user asks to list stages, see ChangeSet stage state, inspect staged workflow progress, or run `harness stages list`.
---

# Harness Runtime Stages

## Command Map

- `./harness stages list <CHG-ID>`

## Procedure

1. Resolve the ChangeSet ID with `./harness changes list` if needed.
2. Run `./harness stages list <CHG-ID>`.
3. Report stage ID, state, required next action, and artifact pointers.
4. Use `harness-runtime-artifacts` for artifact body display or acceptance.
