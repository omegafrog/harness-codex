---
name: harness-full-workflow
description: Run the full harness workflow by orchestrating harness-requirements, harness-usecases, and harness-post-harvest-orchestrator as one resumable flow from early idea through execution. Use when the user wants one skill to carry requirements, use cases, ChangeSet creation, UC slices, event storming, DDD design, technical decisions, planning, execution, verification, and ChangeSet completion while preserving stage state across grill-me and approval pauses.
---

# Harness Full Workflow

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-full-workflow/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
