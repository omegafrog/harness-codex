---
name: spring-package-structure
description: Create or propose initial Spring Boot module and package skeletons plus an executor-facing ARCHITECTURE.md. Use when a user gives a root package and module list and wants Gradle multi-module layout, empty Spring package structure, dependency direction, package responsibilities, starter files or .gitkeep placeholders, ARCHITECTURE.md implementation guidance, and ArchUnit/Semgrep-checkable structure rules without generating domain models, aggregates, entities, value objects, business policies, or use case details.
---

# Spring Package Structure

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/spring-package-structure/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
