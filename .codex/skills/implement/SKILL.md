---
name: implement
description: Execute one approved split plan at a time, with fresh context, tests first, and strict scope control.
---

# implement

## Flow

1. Read `.codex/harness.yaml` and resolve the selected tracker mode.
2. Resolve exactly one approved, executable split plan:
   - GitHub Issues: select a child Issue from the parent plan-set Issue, move its configured GitHub Project `Workflow Status` to `In Progress`, and use its Issue body as the plan.
   - local-markdown: resolve one ticket from the configured directory and set its status to `in-progress`; confirm `docs/plans/plans.md` links to the plan document.
3. Resolve the ticket-scoped Product Spec and Architecture Spec.
4. Reload the current spec, resolved plan representation, and Git state.
5. Execute the plan directly in the current working directory context.
6. Write the failing test for the agreed seam first.
7. Implement the minimum code needed to pass.
8. Run the plan-specific test set and typecheck.
9. Commit the result and update only the selected tracker: GitHub mode sets the child Issue's Project `Workflow Status` to `Done` and closes the child Issue; local-markdown mode sets ticket status to `completed`.
10. Recalculate dependent tickets only in the selected tracker.
12. Run `code-review` skill and print result.
13. Stop and report the updated statuses and whether the next plan can run.

## Rules

- GitHub mode must not write tracker status to local plan Markdown. local-markdown mode must not call `gh` or update a GitHub Project.
- Do not carry stale context across plans.
- Do not spawn or call a subagent for implementation work.
- Do not call another plan executor from inside implementation.
- Do not widen scope without reporting a blocker.
- After every implementation, update and recalculate dependent ticket statuses in the selected tracker.
- Use `Planned`, `In Progress`, `Blocked`, and `Done` in GitHub Project mode; use `planned`, `in-progress`, `blocked`, and `completed` in local-markdown mode.
- If implementation cannot complete because of a blocker, set the selected tracker ticket to its blocked state and report the blocker.
- When implementing Java code, use Lombok to reduce boilerplate: apply `@Getter`, `@Setter`, and `@NoArgsConstructor` for the default constructor where compatible with the class design and project configuration.

PR creation is separate. Do not create a new branch or open a PR unless the user explicitly asks for that later.
