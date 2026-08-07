---
name: implement
description: Execute one approved split plan at a time, with fresh context, tests first, and strict scope control.
---

# implement

## Flow

1. Confirm `docs/plans/plans.md` exists and contains backlinks to individual plan documents.
2. Resolve the requested plan from a `docs/plans/plans.md` backlink. If no specific plan is requested, choose exactly one approved `ready-for-agent` plan from the linked documents.
3. Reload the current spec, resolved plan document, and Git state.
4. Execute the plan directly in the current working directory context.
5. Write the failing test for the agreed seam first.
6. Implement the minimum code needed to pass.
7. Run the plan-specific test set and typecheck.
8. Commit the result and update the individual plan document status to `completed`.
9. Reconcile every linked plan: promote each approved `pending` plan to `ready-for-agent` when all dependencies are `completed`; keep it `pending` when any dependency remains incomplete.
10. Remove `ready-for-agent` from the completed Issue or plan metadata, and apply it to newly unblocked plans.
11. Run `code-review` skill and print result.
12. Stop and report the updated statuses and whether the next plan can run.

## Rules

- Do not run a plan that is not linked from `docs/plans/plans.md`.
- Do not treat `docs/plans/plans.md` as the plan body; it is only the backlink index.
- Do not edit `docs/plans/plans.md` for execution status except to repair a broken or missing backlink with user approval.
- Do not carry stale context across plans.
- Do not spawn or call a subagent for implementation work.
- Do not call another plan executor from inside implementation.
- Do not widen scope without reporting a blocker.
- Do not leave `ready-for-agent` on a finished slice.
- After every implementation, update the completed plan and recalculate all dependent plan statuses in the same run.
- A plan is executable only when approved, all dependencies are `completed`, and its status is `ready-for-agent`; never leave such a plan as `pending`.
- When implementing Java code, use Lombok to reduce boilerplate: apply `@Getter`, `@Setter`, and `@NoArgsConstructor` for the default constructor where compatible with the class design and project configuration.

## Pulled out on purpose

`implement` is the public execution surface. It consumes the slices prepared by `to-ticket`.
PR creation is separate. Do not create a new branch or open a PR unless the user explicitly asks for that later.
