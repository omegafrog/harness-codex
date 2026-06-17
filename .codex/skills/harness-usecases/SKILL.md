---
name: harness-usecases
description:
  Use after requirements and context.md exist to turn confirmed requirements
  into external-actor use cases and runtime-ready use-case slice documents. Also
  use for the harness use-case-definition runtime command.
---

# Harness Use Cases

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-usecases/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
