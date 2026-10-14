---
name: beads
description: Use when a project uses bd or Beads for shared tasks, dependencies, blockers, or durable handoff across sessions and worktrees.
---

# Beads

Use the `bd` CLI as the durable project task tracker when the repository has an active Beads workspace.

## Start

Run `bd prime` for workflow context. If it prints nothing, check `bd where`. Never initialize a database from this skill; project setup owns initialization and must get user approval first.

## Work

- Find tasks with `bd ready` and `bd list --status=open`.
- Inspect before editing with `bd show <id>`.
- Claim atomically with `bd update <id> --claim`.
- Create durable follow-up tasks with `bd create`.
- Close only completed work with `bd close <id> --reason="Completed"`.
- Prefer `--json` when parsing output programmatically.
- Do not use `bd edit`; use `bd update` flags instead.
- Do not duplicate Beads tasks in Markdown TODO lists.

Linked Git worktrees in the same repository share one Beads workspace. Do not create or copy a separate `.beads` directory in a linked worktree. For remote-backed databases, follow the coordinated migration gate: one designated clone migrates and publishes; every other clone adopts that result.
