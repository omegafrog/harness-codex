---
name: implement
description: Execute one approved split plan at a time in the main agent context, tests first, and strict scope control.
---

# implement

## What it does

`implement` executes exactly one approved split plan at a time.

It does not redesign the spec, renegotiate scope, or choose a different plan. It works only from individual plan documents linked from `plans.md` that are already approved and ready.

## Inputs

- `plans.md` backlink index
- approved split plan document linked from `plans.md`
- Product Spec
- Architecture Spec
- current Git state
- `code-research` summary when needed

## Process

1. Confirm `plans.md` exists and contains backlinks to individual plan documents.
2. Resolve the requested plan from a `plans.md` backlink. If no specific plan is requested, choose exactly one approved `ready-for-agent` plan from the linked documents.
3. Reload the current spec, resolved plan document, and Git state before working.
4. Execute the plan directly in the current main agent context.
5. Write the failing test for the agreed seam first.
6. Implement the minimum code needed to pass.
7. Run the plan-specific test set and typecheck.
8. Commit the plan result.
9. Update the individual plan document status.
10. Decide whether the next plan can run.

## Rules

- Do not execute a plan that is not linked from `plans.md`.
- Do not treat `plans.md` as the plan body; it is only the backlink index.
- Do not edit `plans.md` for execution status except to repair a broken or missing backlink with user approval.
- Do not continue past a failed test or unresolved blocker.
- Do not reuse stale context between plans.
- Do not spawn or call a subagent for implementation work.
- Do not call another plan executor from inside implementation.
- Keep implementation inside the approved scope.
- Report blockers instead of patching around them silently.

## Output

- executed plan summary
- tests and typecheck result
- commit reference
- next-plan readiness

## Pulled out on purpose

`implement` is the execution boundary. `to-ticket` prepares the slices, and `code-review` checks the result after execution.
