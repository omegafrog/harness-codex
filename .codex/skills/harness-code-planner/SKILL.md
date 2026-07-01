---
name: harness-code-planner
description: Create or maintain an executor-ready implementation plan for one active ChangeSet work item. Use after a ChangeSet and one work-item slice exist and before coding starts, or when updating that active work-item plan. The skill keeps planning scoped to the active ChangeSet and writes only `docs/plans/active/<WORK-ITEM-ID>/plan.md`.
---

# Harness Code Planner

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-code-planner/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- When updating an existing active plan after a runtime failure, read `.codex/skills/harness-code-planner/references/plan-mutation-policy.md` before editing.
- On a runtime-triggered rerun, use the run id and work-item id from the runtime payload to inspect the current run's `verification/repair-brief.json` when it exists. If it is absent and the post-implementation security review was rejected, inspect that run's `security/security-review.md`. Use the evidence only for the smallest required plan patch; do not copy the report into the plan.
- Read additional files named by the detailed reference only when the current task needs them.
- The workflow completion destination is `docs/plans/completed/<WORK-ITEM-ID>/plan.md`; this skill never writes, deletes, or moves that path.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
