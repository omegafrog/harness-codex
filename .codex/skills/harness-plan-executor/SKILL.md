---
name: harness-plan-executor
description: Orchestrate use-case scoped execution of active implementation plans for harness engineering by delegating implementation to the implementation_executor agent, verifying against the use-case E2E goal and test gate, adding remediation tasks only for implementation failures, and moving completed use-case plans to completed plans. Also use for the harness implementation runtime command.
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
