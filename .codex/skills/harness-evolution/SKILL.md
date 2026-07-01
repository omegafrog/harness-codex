---
name: harness-evolution
description: Manage harness evolution proposals through the runtime CLI. Use when the user asks to propose, accept, reject, inspect, or decide repo workflow evolution changes with `harness evolution`.
---

# Harness Evolution

## Command Map

- `./harness evolution propose ...`
- `./harness evolution accept ...`
- `./harness evolution reject ...`

## Procedure

1. Run `./harness help evolution` to confirm exact required arguments for current runtime.
2. Treat accept/reject as workflow-governance decisions; confirm target proposal before applying.
3. Record proposal IDs and changed files in the response.
4. Do not mix proposal decisions with unrelated implementation edits.
