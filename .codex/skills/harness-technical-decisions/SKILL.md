---
name: harness-technical-decisions
description: >
  Use after harness DDD design or maintenance scope analysis is complete and before implementation planning
  to decide detailed technical strategies such as polling vs push, retry and
  circuit breaker policy, outbox/inbox, idempotency, transaction boundaries,
  cache policy, observability, and adapter-level technology choices. Writes
  use-case or maintenance technical-decisions docs for ChangeSet work and requires approval
  before planning. Also use for the harness technical-decisions runtime command.
---

# Harness Technical Decisions

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-technical-decisions/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Write technical-decision artifacts, questions, recommended answers, blockers, and user-facing summaries in Korean/한국어 while preserving runtime-required keys and status values such as `Approval Status`, `approved`, and `pending`.
- Keep writes inside the scope declared by the caller or runtime payload.
- For maintenance work, write only `docs/maintenance/<MAINT-ID>/technical-decisions.md` and use the maintenance ChangeSet documents as input.
- For maintenance work, use `.harness/docs/templates/maintenance/technical-decisions.md`; preserve its `Approval Status` and `승인 근거` metadata. Mark `approved` only when all decisions are supported by explicit user input or approved maintenance documents; otherwise mark `pending` and list exact unresolved questions.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
