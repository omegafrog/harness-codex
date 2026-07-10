---
name: harness-bug-maintenance-bootstrap
description: Create a bounded bug maintenance document slice after orchestration classification.
---

# Bug Maintenance Bootstrap

- Use only from the `create-bug-maintenance-slice` workflow step.
- Consume the active ChangeSet, issue evidence, existing maintenance templates, and repository commands.
- Write the required maintenance Markdown documents under one `docs/maintenance/<MAINT-ID>/` path.
- Keep the scope to reproduction evidence, root-cause candidate, minimal fix boundary, and verification.
- Record actual Java/Gradle or repository-specific commands in `verification-goal.md`.
- Do not invoke CLI workflows, create code/tests, or choose the next route.
- Return the existing `subagent-result.xml` contract and terminate.
