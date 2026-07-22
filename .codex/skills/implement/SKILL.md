---
name: implement
description: Execute one approved split plan at a time, with fresh context, tests first, and strict scope control.
---

# implement

## Flow

1. Confirm the plan exists in `plans.md` and is approved.
2. Reload the current spec, plan, and Git state.
3. Use fresh direct-child Executor context for the plan.
4. Write the failing test for the agreed seam first.
5. Implement the minimum code needed to pass.
6. Run the plan-specific test set and typecheck.
7. Commit the result and update `plans.md`.
8. Stop and report whether the next plan can run.

## Rules

- Do not run a plan outside `plans.md`.
- Do not carry stale context across plans.
- Do not call another plan executor from inside a plan executor.
- Do not widen scope without reporting a blocker.

## Pulled out on purpose

`implement` is the public execution surface. It consumes the slices prepared by `to-ticket`.
