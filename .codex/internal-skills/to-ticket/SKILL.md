# to-ticket

## What it does

`to-ticket` turns a completed Product Spec and Architecture Spec into implementation-ready work slices. It keeps the split small, dependency-aware, and traceable back to the spec.

It does not redesign the product. It does not reopen architecture decisions unless the spec is internally inconsistent or the codebase has a hard constraint that must be surfaced.

## Inputs

- Product Spec
- Architecture Spec
- `CONTEXT.md`
- `CONTEXT-MAP.md` if present
- `code-research` summary

## Process

1. Read the Product Spec and Architecture Spec first.
2. Run `code-research` to summarize the current codebase as the baseline for slicing.
3. Split the work into tracer-bullet or smart-zone vertical slices.
4. Attach the required test contract to each slice:
   - policy-based unit tests
   - `ui ~ entity` e2e tests
5. Define the dependency order between slices.
6. Present the split plan to the user and wait for approval before mutating GitHub or plan files.
7. After approval, create Issues, split plans, and the `plans.md` entries so they stay in one-to-one correspondence.
8. Publish each Issue using the tracker-specific form:
   - GitHub: apply labels on the issue
   - local markdown: write the same roles into frontmatter or an equivalent metadata block
9. Mark `ready-for-agent` only when the slice is implementation-ready.
10. Initialize the context needed for `implement`.

## Rules

- Do not mutate GitHub or local plan files before approval.
- Keep each split plan vertically coherent.
- Include policy-based unit tests and `ui ~ entity` e2e tests in every split plan.
- Do not split only by layer when that breaks the use-case slice.
- Reject dependency cycles.
- Keep one Issue matched to one split plan.
- Use tracker-specific label strings only after the tracker mode is known.
- Keep the canonical roles `bug`, `enhancement`, and one state role per Issue.
- Add `ready-for-agent` only when the slice is implementation-ready.

## Output

- ordered slice list
- dependency map
- proposed Issue titles and labels
- split plan entries
- implement handoff context

## Pulled out on purpose

`to-ticket` is the bridge between design and execution. `spec-me` recommends it after the specs are stable, and `implement` consumes the slices it prepares.
