# Internal capability routing

Read the matching internal GUIDE and follow its scope. For work that belongs to a Harness workflow, use the workflow route instead.

| User request | Internal GUIDE |
|---|---|
| Diagnose a bug or regression | `.harness/internal-skills/diagnosing-bugs/GUIDE.md` |
| Prevent recurring agent or workflow mistakes | `.harness/internal-skills/correct/GUIDE.md` |
| Maintain or recover a Harness installation (a plain update is the public `harness-update` skill) | `.harness/internal-skills/harness-maintenance/GUIDE.md` or `.harness/internal-skills/harness-recover/GUIDE.md` |
| Collect engineering sources or assess Harness evaluations | `.harness/internal-skills/knowledge-harvest/GUIDE.md` or `.harness/internal-skills/evaluate-harness/GUIDE.md` |
| Design or implement frontend work | `.harness/internal-skills/frontend-design/GUIDE.md` |
| Implement from an already completed tactical design | `.harness/workflows/tactical-to-code.yaml` and its stage GUIDE files: decisions, then `to-ticket`, user-approved `tracker-publish`, then `tactical-code` per ticket; UI remains a separate `frontend-design` workflow |
| Review a change or manage its integration pull request | `.harness/internal-skills/code-review/references/repair.md` or `.harness/internal-skills/gh-open-pr/GUIDE.md` |
| Reconcile user-facing verification documentation | `.harness/internal-skills/maintain-verification/GUIDE.md` |
| Run explicit user-journey E2E verification | `.harness/internal-skills/e2e-test/GUIDE.md` |
| Ask focused design questions | `.harness/internal-skills/grilling/GUIDE.md` |
| Explain a topic simply | public `eli5` skill |
| Summarize provided material | `.harness/internal-skills/attention-span/GUIDE.md` |

For internal workflow actions, read their supporting references from the same directory as the GUIDE. Never select a GUIDE solely because a keyword appears; match the requested outcome and current workflow state.
