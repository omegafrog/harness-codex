---
name: harness-plan-executor
description: Orchestrate execution of one UC or maintenance work-item plan at docs/plans/active/<WORK-ITEM-ID>/plan.md, verify it against its E2E or maintenance verification goal and test gate, remediate implementation failures, and move only that completed plan to docs/plans/completed/<WORK-ITEM-ID>/plan.md.
---

# Harness Plan Executor

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-plan-executor/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
