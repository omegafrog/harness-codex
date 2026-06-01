---
name: harness-event-storming
description: >
  Use after requirements and use cases exist to run ticketon-ddd style event
  storming through the oracle agent. The skill derives commands, events,
  policies, systems, external systems, and invariants from use cases, and
  writes docs/use-cases/<UC-ID>/event-storming.md for each affected use-case
  slice.
---

# Harness Event Storming

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-event-storming/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
