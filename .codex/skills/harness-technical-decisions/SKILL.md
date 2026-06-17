---
name: harness-technical-decisions
description: >
  Use after harness DDD design is complete and before implementation planning
  to decide detailed technical strategies such as polling vs push, retry and
  circuit breaker policy, outbox/inbox, idempotency, transaction boundaries,
  cache policy, observability, and adapter-level technology choices. Writes
  use-case technical-decisions docs for ChangeSet work and requires approval
  before planning. Also use for the harness technical-decisions runtime command.
---

# Harness Technical Decisions

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-technical-decisions/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
