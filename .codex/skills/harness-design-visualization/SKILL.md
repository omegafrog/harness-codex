---
name: harness-design-visualization
description: >
  Use after approved technical decisions and before implementation planning to render
  a use-case class diagram and flow diagram from canonical design evidence. Produces
  Mermaid Markdown plus source-hash metadata and blocks planning when diagrams are
  missing, stale, or unsupported. Also use for the harness design-visualization command.
---

# Harness Design Visualization

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-design-visualization/references/detailed-instructions.md` before producing artifacts.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
