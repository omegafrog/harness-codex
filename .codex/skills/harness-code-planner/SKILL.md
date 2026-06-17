---
name: harness-code-planner
description: Create or maintain an executor-ready implementation plan for one active ChangeSet work item. Use after a ChangeSet and one work-item slice exist and before coding starts, or when updating/completing that work-item plan. Also use for the harness plan-writing runtime command. The skill keeps planning scoped to the active ChangeSet and moves plans to completed only after all checkbox tasks and build/test/e2e/runtime-server/static-analysis verification are complete.
---

# Harness Code Planner

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-code-planner/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
