---
name: harness-ddd-design
description: >
  Use after event storming exists to design DDD components without generating
  code. The skill runs the ddd_architect agent to derive domain models,
  aggregates, bounded contexts, application services, domain services, and
  communication maps from the selected use-case slice. The selected slice
  event-storming document is the primary source; outside/canonical documents are
  fallback only for information missing from the slice. Also use for the harness
  ddd-architecture-definition runtime command.
---

# Harness DDD Design

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-ddd-design/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
