---
name: harness-change-set-bootstrap
description: Create one active ChangeSet document from an initial instruction before downstream workflow routing.
---

# ChangeSet Bootstrap

- Use only when the orchestration workflow declares `create-change-set` and no active ChangeSet exists.
- Read `AGENTS.md`, the original instruction, the existing ChangeSet template, and minimal repository context.
- Write exactly one `docs/changes/active/<CHG-ID>.md` using the existing template.
- Keep the ChangeSet scope coherent and bounded to the original instruction.
- Include one affected use case or maintenance work item when the instruction identifies one.
- Do not create downstream maintenance/use-case/design/plan artifacts in this step.
- Do not implement code or run workflow stage commands.
- Return the existing `subagent-result.xml` contract after the document is written, then terminate.
- Report a blocker if no coherent title, scope, or affected work item can be derived.
