---
name: ddd-architecture-linter
description: Create, install, run, or modify Java/Spring DDD architecture linting infrastructure. Use when a user wants Codex to set up ArchUnit/Semgrep/Gradle/CI linting, run architecture lint checks, add a new architecture rule, change severity, disable or remove an existing rule, or update rules that prevent code from breaking domain/application/infra/controller, aggregate, messaging, transaction, or bounded-context boundaries.
---

# DDD Architecture Linter

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/ddd-architecture-linter/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
