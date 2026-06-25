---
name: harness-ubiquitous-language
description:
  Use after requirements are stable to confirm project ubiquitous language in
  docs/design/ubiquitous-language.md before use-case generation. Also use for the harness
  ubiquitous-language-definition runtime command.
---

# Harness Ubiquitous Language

## Hot Path

- Use this skill only after `docs/design/요구사항.md` exists.
- Read `.codex/skills/harness-ubiquitous-language/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report an upstream requirements blocker if actor, goal, success condition, failure policy, or scope boundary is missing or contradictory.
- Report changed files, verification commands, and blockers clearly.
