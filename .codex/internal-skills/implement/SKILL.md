---
name: implement
description: Execute one approved split plan at a time in the main agent context, tests first, and strict scope control.
---

# implement

## What it does

`implement` executes exactly one approved split plan at a time.

It does not redesign the spec, renegotiate scope, or choose a different plan. It works only from individual plan documents linked from `docs/plans/plans.md` that are already approved and ready.

## Inputs

- `docs/plans/plans.md` backlink index
- approved split plan document linked from `docs/plans/plans.md`
- Product Spec
- Architecture Spec
- current Git state
- `code-research` summary when needed

## Process

1. Confirm `docs/plans/plans.md` exists and contains backlinks to individual plan documents.
2. Resolve the requested plan from a `docs/plans/plans.md` backlink. If no specific plan is requested, choose exactly one approved `ready-for-agent` plan from the linked documents.
3. Set the selected plan status to `in-progress` and remove its `ready-for-agent` triage label before changing code.
4. Reload the current spec, resolved plan document, and Git state before working.
5. Execute the plan directly in the current main agent context.
6. Write the failing test for the agreed seam first.
7. Implement the minimum code needed to pass.
8. Run the plan-specific test set and typecheck.
9. Commit the implementation result while the plan remains `in-progress`.
10. Run `code-review` against the implementation commit and print the result.
11. Resolve the review gate: if either review axis reports an unresolved blocker, set the plan status to `blocked`; if review cannot finish, leave the plan `in-progress`; only a finished review with no unresolved blockers may set the plan status to `completed`.
12. Only after the plan becomes `completed`, reconcile every linked plan: promote each approved `planned` plan to `ready-for-agent` when all dependencies are `completed`; keep it `planned` when any dependency remains incomplete.
13. Keep Issue labels aligned: remove `ready-for-agent` from the selected Issue, and apply it only to newly unblocked plans after successful completion.
14. Decide whether the next plan can run and report the review outcome and updated statuses.

## Rules

- Do not execute a plan that is not linked from `docs/plans/plans.md`.
- Do not treat `docs/plans/plans.md` as the plan body; it is only the backlink index.
- Do not edit `docs/plans/plans.md` for execution status except to repair a broken or missing backlink with user approval.
- Do not continue past a failed test or unresolved blocker.
- Do not reuse stale context between plans.
- Do not spawn or call a subagent for implementation work.
- Do not call another plan executor from inside implementation.
- Keep implementation inside the approved scope.
- Report blockers instead of patching around them silently.
- Do not leave `ready-for-agent` on a finished slice.
- Code review is part of verification and gates `completed`; never mark a plan `completed` or release dependent plans before review finishes without unresolved blockers.
- If code review reports an unresolved blocker, set the plan status to `blocked`, keep dependent plans unchanged, remove `ready-for-agent`, and report the blocker.
- If code review cannot finish because it is pending, timed out, or unavailable, remain `in-progress`, keep dependent plans unchanged, and report that review cannot finish.
- After successful implementation and review, update the completed plan and recalculate all dependent plan statuses in the same run.
- Use only `planned`, `ready-for-agent`, `in-progress`, `completed`, and `blocked` plan statuses. Never write `pending`.
- A plan is executable only when approved, all dependencies are `completed`, and its status is `ready-for-agent`; never leave such a plan as `planned`.
- If implementation cannot complete because of a blocker, set the plan status to `blocked`, remove `ready-for-agent`, and report the blocker.
- When implementing Java code, use Lombok to reduce boilerplate: apply `@Getter`, `@Setter`, and `@NoArgsConstructor` for the default constructor where compatible with the class design and project configuration.

## Output

- executed plan summary
- tests and typecheck result
- commit reference
- next-plan readiness

## Pulled out on purpose

`implement` is the execution boundary. `to-ticket` prepares the slices, and `code-review` checks the result after execution.
