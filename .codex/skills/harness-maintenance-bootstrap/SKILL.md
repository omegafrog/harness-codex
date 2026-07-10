---
name: harness-maintenance-bootstrap
description: Create a bounded general maintenance document slice after orchestration classification.
---

# Maintenance Bootstrap

- Use only from the `create-maintenance-slice` workflow step.
- Consume the active ChangeSet, original instruction, existing maintenance templates, and repository commands.
- Write the required maintenance Markdown documents under one `docs/maintenance/<MAINT-ID>/` path.
- Cover refactor, test, infra, docs, or chore scope without inventing product behavior.
- Record explicit Before/After, non-goals, architecture impact, links, and repository-specific verification commands.
- Do not invoke CLI workflows, create code/tests, or choose the next route.
- Return the existing `subagent-result.xml` contract and terminate.
