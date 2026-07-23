---
name: implement
description: Execute one approved split plan at a time, with fresh context, tests first, and strict scope control.
---

# implement

## Flow

1. Confirm `plans.md` exists and contains backlinks to individual plan documents.
2. Resolve the requested plan from a `plans.md` backlink. If no specific plan is requested, choose exactly one approved `ready-for-agent` plan from the linked documents.
3. Reload the current spec, resolved plan document, and Git state.
4. Execute the plan directly in the current working directory context.
5. Write the failing test for the agreed seam first.
6. Implement the minimum code needed to pass.
7. Run the plan-specific test set and typecheck.
8. Commit the result and update the individual plan document status.
9. Mark the matching checkbox in `plans.md` as complete.
10. Run `code-review` skill and print result.
11. Stop and report whether the next plan can run.

## Rules

- Do not run a plan that is not linked from `plans.md`.
- Do not treat `plans.md` as the plan body; it is only the backlink index.
- Do not edit `plans.md` except to mark the matching plan checkbox complete or repair a broken or missing backlink with user approval.
- Do not carry stale context across plans.
- Do not spawn or call a subagent for implementation work.
- Do not call another plan executor from inside implementation.
- Do not widen scope without reporting a blocker.

## Pulled out on purpose

`implement` is the public execution surface. It consumes the slices prepared by `to-ticket`.
PR creation is separate. Do not create a new branch or open a PR unless the user explicitly asks for that later.
