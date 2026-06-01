---
name: harness-requirements
description:
  Use when a user wants to turn an early product or feature idea into a
  requirements specification. This skill clarifies unresolved requirements
  decisions through a time-boxed grill-me flow and writes docs/design/요구사항.md.
---

# Harness Requirements

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-requirements/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Do not own full ubiquitous language confirmation; route that work to `$harness-ubiquitous-language`.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
