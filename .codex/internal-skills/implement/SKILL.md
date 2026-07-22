---
name: implement
description: Execute one approved split plan at a time, using fresh direct-child executor context, tests first, and strict scope control.
---

# implement

## What it does

`implement` executes exactly one approved split plan at a time.

It does not redesign the spec, renegotiate scope, or choose a different plan. It works only from `plans.md` entries that are already approved and ready.

## Inputs

- `plans.md`
- approved split plan
- Product Spec
- Architecture Spec
- current Git state
- `code-research` summary when needed

## Process

1. Confirm the requested plan exists in `plans.md` and is ready.
2. Reload the current spec, plan, and Git state before working.
3. Create a fresh direct-child Executor context for the plan.
4. Write the failing test for the agreed seam first.
5. Implement the minimum code needed to pass.
6. Run the plan-specific test set and typecheck.
7. Commit the plan result.
8. Update `plans.md` status.
9. Decide whether the next plan can run.

## Rules

- Do not execute a plan that is not listed in `plans.md`.
- Do not continue past a failed test or unresolved blocker.
- Do not reuse stale context between plans.
- Do not call another plan executor from inside a plan executor.
- Keep implementation inside the approved scope.
- Report blockers instead of patching around them silently.

## Output

- executed plan summary
- tests and typecheck result
- commit reference
- next-plan readiness

## Pulled out on purpose

`implement` is the execution boundary. `to-ticket` prepares the slices, and `code-review` checks the result after execution.
