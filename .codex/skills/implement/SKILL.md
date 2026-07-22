---
name: implement
description: Execute one approved split plan at a time, with fresh context, tests first, and strict scope control.
---

# implement

## Flow

1. Create new branch from origin/main and check it out.
2. Confirm `plans.md` exists and contains backlinks to individual plan documents.
3. Resolve the requested plan from a `plans.md` backlink. If no specific plan is requested, choose exactly one approved `ready-for-agent` plan from the linked documents.
4. Reload the current spec, resolved plan document, and Git state.
5. Execute the plan directly in the current main agent context.
6. Write the failing test for the agreed seam first.
7. Implement the minimum code needed to pass.
8. Run the plan-specific test set and typecheck.
9. Commit the result and update the individual plan document status.
10. run `code-review` skill and print result.
11. Stop and report whether the next plan can run.

## Rules

- Do not run a plan that is not linked from `plans.md`.
- Do not treat `plans.md` as the plan body; it is only the backlink index.
- Do not edit `plans.md` for execution status except to repair a broken or missing backlink with user approval.
- Do not carry stale context across plans.
- Do not spawn or call a subagent for implementation work.
- Do not call another plan executor from inside implementation.
- Do not widen scope without reporting a blocker.

## Pulled out on purpose

`implement` is the public execution surface. It consumes the slices prepared by `to-ticket`.
