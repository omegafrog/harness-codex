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
7. After approval, create Issues, one split plan document per slice, and a newly generated backlink index at `docs/plans/plans.md` so they stay in one-to-one correspondence.
8. Publish each Issue using the tracker-specific form:
   - GitHub: apply labels on the issue
   - local markdown: write the same roles into frontmatter or an equivalent metadata block
9. Mark `ready-for-agent` only when the slice is implementation-ready.
10. Use `completed` as the terminal plan status written by `implement`.
11. Initialize the context needed for `implement`.

## Rules

- Do not mutate GitHub or local plan files before approval.
- Keep each split plan vertically coherent.
- Include policy-based unit tests and `ui ~ entity` e2e tests in every split plan.
- Do not split only by layer when that breaks the use-case slice.
- Reject dependency cycles.
- Keep one Issue matched to one split plan.
- Store each split plan in its own Markdown file, for example `docs/plans/<plan-id>.md`.
- Keep `docs/plans/plans.md` as an index only. It contains backlinks to individual plan documents, not full plan bodies.
- Always create or overwrite `docs/plans/plans.md` for the current ticket set after approval; do not preserve or append prior index entries.
- Put plan status, dependencies, acceptance criteria, test contract, and implementation scope in the individual plan document.
- Write a Korean `구현 목적` section in every plan document. Explain clearly what the plan will implement and why, so the intended implementation is understandable without reading the Issue.
- Use `completed` as the terminal plan status.
- Do not collapse multiple plan documents into a single `plans.md` body.
- Use tracker-specific label strings only after the tracker mode is known.
- Keep the canonical roles `bug`, `enhancement`, and one state role per Issue.
- Add `ready-for-agent` only when the slice is implementation-ready.

## Output

- ordered slice list
- dependency map
- proposed Issue titles and labels
- individual plan document links
- implement handoff context

## Pulled out on purpose

`to-ticket` is the bridge between design and execution. `spec-me` recommends it after the specs are stable, and `implement` consumes the slices it prepares.
