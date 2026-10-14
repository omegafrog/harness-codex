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

## Harness ticket mirrors

`to-ticket` creates Beads mirrors for the tickets in the configured tracker. The configured tracker remains authoritative; mirror these lifecycle transitions in Beads so the shared board reflects execution:

| Configured tracker | Beads |
|---|---|
| `planned` / `Planned` | `open` |
| `in-progress` / `In Progress` | `in_progress` |
| `blocked` / `Blocked` | `blocked` |
| `completed` / `Done` | `closed` via `bd close` |

Resolve a mirror by its exact `external_ref` using `bd list --all --json --external-ref "$TICKET_REF"`. Update exactly one match and verify it with `bd show <id> --json`. If multiple matches exist, stop and report the duplicate. If none exists for a legacy ticket, continue using the configured tracker and report that no Beads mirror was found; do not create a new Bead during implementation.

`blocked` and `blocking` describe dependency direction, not duplicate ticket states: a ticket is blocked by an unfinished prerequisite; a blocking ticket is the prerequisite that another ticket depends on. `bd dep add <blocked-ticket-id> <blocker-ticket-id>` records that direction. Finish the blocker first; the dependent ticket becomes eligible after its prerequisite is completed.

Linked Git worktrees in the same repository share one Beads workspace. Do not create or copy a separate `.beads` directory in a linked worktree. For remote-backed databases, follow the coordinated migration gate: one designated clone migrates and publishes; every other clone adopts that result.
