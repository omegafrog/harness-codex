---
name: implement
description: Execute one approved split plan at a time, with fresh context, tests first, and strict scope control.
---

# implement

## Flow

1. Read `.codex/harness.yaml` and resolve the selected tracker mode and `agents.execution_model` plus `agents.execution_reasoning_effort` when runtime/E2E verification is required.
2. Resolve exactly one approved, executable split plan:
   - GitHub Issues: select a child Issue from the parent plan-set Issue, move its configured GitHub Project `Workflow Status` to `In Progress`, and use its Issue body as the plan.
   - local-markdown: resolve one ticket from the configured directory and set its status to `in-progress`; confirm the plan-set's `docs/plans/<plan-set-id>/plans.md` links to the plan document.
3. Resolve the ticket-scoped Product Spec and Architecture Spec.
4. Read `docs/architecture/constraints.md` when present, then reload the current spec, resolved plan representation, and Git state.
5. Capture the pre-implementation `HEAD` as the code-review fixed point, then execute the plan directly in the current working directory context.
6. Write the failing test for the agreed seam first.
7. Implement the minimum code needed to pass.
8. Run the plan-specific test set and typecheck. If the plan requires actual E2E or server execution, spawn `execution_runner` with `model: agents.execution_model` and `reasoning_effort: agents.execution_reasoning_effort`; wait for its polling result before completion.
9. Commit the result. A split plan never creates or updates its own PR. In GitHub mode, keep the child Issue open, but move its Project `Workflow Status` to `Done` once this plan's implementation and verification gates pass. The plan-set integration PR is created only after every split plan is `Done`.
10. Run `code-review` against the captured fixed point and print both independent results. `standards_reviewer` checks whether the implementation satisfies the Product Spec. `spec_reviewer` checks whether the implementation satisfies the Architecture Spec. Pass both ticket-scoped Spec paths, wait for both reviewers, and keep the plan unresolved if either report is missing.
11. Only after both review results are available and resolved, set the selected ticket to its terminal state: `Done` in GitHub mode and `completed` in local-markdown mode.
12. Recalculate dependent tickets as soon as their dependencies reach those terminal states. Keep only incomplete or unresolved tickets waiting.
13. Stop and report the updated statuses and whether the next plan can run. Invoke or recommend `gh-open-pr` exactly once only when every split plan in the plan set has passed verification and reached its terminal status; create or update the single plan-set implementation PR. Do not merge the PR automatically.

## Rules

- GitHub mode must not write tracker status to local plan Markdown. local-markdown mode must not call `gh` or update a GitHub Project.
- Do not carry stale context across plans.
- Do not spawn or call a subagent for implementation work. `execution_runner` is allowed only for separate runtime verification and must not edit implementation files.
- This prohibition does not apply to the mandatory read-only `standards_reviewer` and `spec_reviewer` review agents required by step 12.
- Do not call another plan executor from inside implementation.
- Do not widen scope without reporting a blocker.
- GitHub mode에서 테스트·개발 중 새 Issue가 필요하면 `tracker.github.assignees.codex`를 `CODEX_ASSIGNEE`로 해석해 `--assignee "$CODEX_ASSIGNEE"`로 만든다. 기본값은 `@copilot`이다. 기존 Issue의 assignee는 명시적 요청 없이 변경하지 않는다.
- 구현 완료한 split plan은 child Issue를 닫지 않되 Project `Workflow Status`를 `Done`으로 전환한다. `gh-open-pr`는 모든 split plan 완료 후 하나의 plan-set integration PR에만 closing keyword를 넣는다.
- Recalculate dependent tickets after their dependency reaches its terminal tracker status, not after the plan-set PR merges.
- Use `Planned`, `In Progress`, `Blocked`, and `Done` in GitHub Project mode; use `planned`, `in-progress`, `blocked`, and `completed` in local-markdown mode.
- If implementation cannot complete because of a blocker, set the selected tracker ticket to its blocked state and report the blocker.
- When implementing Java code, use Lombok to reduce boilerplate: apply `@Getter`, `@Setter`, and `@NoArgsConstructor` for the default constructor where compatible with the class design and project configuration.

PR creation remains a separate `gh-open-pr` step. Do not create or update a PR at an individual split-plan boundary. Once every split plan is fully complete and both reviews are resolved, create or recommend exactly one plan-set integration PR. Do not create a new branch or open a PR before that point, and do not merge the PR automatically.
