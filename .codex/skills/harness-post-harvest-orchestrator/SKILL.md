---

name: harness-post-harvest-orchestrator
description: Run the complete ChangeSet-based harness workflow after harvest has produced requirements and use cases. Use to orchestrate ChangeSet creation, affected use-case selection, use-case scoped event storming, DDD design, technical decisions, E2E goal approval, use-case planning, execution, verification, remediation loops, project wiki updates, ChangeSet completion, and target-repository PR creation.

---

# Harness Post-Harvest Orchestrator

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-post-harvest-orchestrator/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
