---
name: harness-code-planner
description: Create or maintain an executor-ready implementation plan for one active ChangeSet work item. Use after a ChangeSet and one work-item slice exist and before coding starts, or when updating that active work-item plan. The skill keeps planning scoped to the active ChangeSet and writes only `docs/plans/active/<WORK-ITEM-ID>/plan.md`.
---

# Harness Code Planner

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-code-planner/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- When updating an existing active plan after a runtime failure, read `.codex/skills/harness-code-planner/references/plan-mutation-policy.md` before editing.
- When executor verification evidence with `failure code="verification_root_cause"` is supplied for plan repair, read `.codex/agents/references/observed-problem-resolution.md` and plan the smallest observable root-cause removal.
- On a rerun, inspect the current run's canonical `subagent-result.xml` and evidence only when the orchestration agent explicitly supplies it for plan repair.
- Read additional files named by the detailed reference only when the current task needs them.
- The workflow completion destination is `docs/plans/completed/<WORK-ITEM-ID>/plan.md`; this skill never writes, deletes, or moves that path.
- Keep writes inside the scope declared by the caller or runtime payload.
- Consume only the current step's `.harness/runs/<RUN-ID>/steps/<STEP-ID>/subagent-invocation.xml` and declared document artifacts. Return one matching result at that step directory's `subagent-result.xml`, then terminate; do not route or execute downstream work.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
