# Internal capability routing

Read the matching internal GUIDE and follow its scope. For work that belongs to a Harness workflow, use the workflow route instead.

| User request | Internal GUIDE |
|---|---|
| Diagnose a bug or regression | `.harness/skills/operations/diagnosing-bugs/GUIDE.md` |
| Prevent recurring agent or workflow mistakes | `.harness/skills/operations/correct/GUIDE.md` |
| Maintain or recover a Harness installation (a plain update is the public `harness-update` skill) | `.harness/skills/operations/harness-maintenance/GUIDE.md` or `.harness/skills/operations/harness-recover/GUIDE.md` |
| Collect engineering sources or assess Harness evaluations | `.harness/skills/research/knowledge-harvest/GUIDE.md` or `.harness/skills/quality/evaluate-harness/GUIDE.md` |
| Design or implement frontend work | `.harness/skills/delivery/frontend-design/GUIDE.md` |
| Implement from an already completed tactical design | `.harness/workflows/tactical-to-code.yaml` and its stage GUIDE files: decisions, then `to-ticket`, user-approved `tracker-publish`, then `tactical-code` per ticket; UI remains a separate `frontend-design` workflow |
| Review a change or manage its integration pull request | `.harness/skills/quality/code-review/references/repair.md` or `.harness/skills/operations/gh-open-pr/GUIDE.md` |
| Reconcile user-facing verification documentation | `.harness/skills/quality/maintain-verification/GUIDE.md` |
| Run explicit user-journey E2E verification | `.harness/skills/quality/e2e-test/GUIDE.md` |
| Run a stage-owned, coverage-driven interview that updates canonical project documents | `.harness/skills/requirements/grill-with-docs/GUIDE.md` (the owning stage supplies the checklist; this is not a separate workflow stage) |
| Ask focused design questions | `.harness/skills/requirements/grilling/GUIDE.md` |
| Explain a topic simply | public `eli5` skill |

For internal workflow actions, read their supporting references from the same directory as the GUIDE. Never select a GUIDE solely because a keyword appears; match the requested outcome and current workflow state.
