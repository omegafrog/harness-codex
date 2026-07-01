# Agent Session State

## Current Known State

- Root `AGENTS.md` existed before compaction and was already staged as new work.
- No nested `AGENTS.md` files existed before compaction.
- `.harness/docs/agent/` was absent before compaction.
- Existing staged ChangeSet and use-case documents are user work and must be preserved.

## Active Work References

- Active ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- Canonical requirements: Korean-named requirements markdown file under `docs/design/`
- Canonical use cases: Korean-named use-case markdown file under `docs/design/`
- Use-case slices: `docs/use-cases/UC-001/`, `docs/use-cases/UC-002/`, `docs/use-cases/UC-003/`

## Handoff Notes

Agent-context compaction should modify only `AGENTS.md` and files under `.harness/docs/agent/`. Do not rewrite existing ChangeSet, design, template, runtime, test, or UI files as part of this task.

Before additional work, check `git status --porcelain=v1 -uno` and preserve unrelated staged or unstaged changes.
