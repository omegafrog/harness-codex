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

1. Read `.codex/harness.yaml` and resolve the selected tracker mode.
2. GitHub mode: resolve one Issue and move its configured GitHub Project `Workflow Status` to `In Progress`. local-markdown mode: resolve one ticket from the configured directory and set its status to `in-progress`.
4. Reload the current spec, resolved plan document, and Git state before working.
5. Execute the plan directly in the current main agent context.
6. Write the failing test for the agreed seam first.
7. Implement the minimum code needed to pass.
8. Run the plan-specific test set and typecheck.
9. Commit the plan result and update only the selected tracker: GitHub mode sets Project `Workflow Status` to `Done` and closes the Issue; local-markdown mode sets the ticket status to `completed`.
10. Recalculate dependent tickets only in the selected tracker.
13. Decide whether the next plan can run and report the updated statuses.

## Rules

- GitHub mode must not write tracker status to local plan Markdown. local-markdown mode must not call `gh` or update a GitHub Project.
- Do not continue past a failed test or unresolved blocker.
- Do not reuse stale context between plans.
- Do not spawn or call a subagent for implementation work.
- Do not call another plan executor from inside implementation.
- Keep implementation inside the approved scope.
- Report blockers instead of patching around them silently.
- After every implementation, update and recalculate dependent ticket statuses in the selected tracker.
- Use `Planned`, `In Progress`, `Blocked`, and `Done` in GitHub Project mode; use `planned`, `in-progress`, `blocked`, and `completed` in local-markdown mode.
- If implementation cannot complete because of a blocker, set the selected tracker ticket to its blocked state and report the blocker.
- A GitHub label command failure is a tracker-sync blocker. Report the affected Issue and command; do not report the plan graph as reconciled.
- When implementing Java code, use Lombok to reduce boilerplate: apply `@Getter`, `@Setter`, and `@NoArgsConstructor` for the default constructor where compatible with the class design and project configuration.

## Output

- executed plan summary
- tests and typecheck result
- commit reference
- next-plan readiness

## Pulled out on purpose

`implement` is the execution boundary. `to-ticket` prepares the slices, and `code-review` checks the result after execution.
