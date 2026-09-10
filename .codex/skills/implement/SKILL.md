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
9. Commit the result. In GitHub mode, keep the child Issue open and its Project `Workflow Status` at `In Progress`; implementation completion alone must not close the child or set it to `Done`. The single plan-set implementation PR applies the `gh-open-pr` scope rule after merge: it closes parent and all children.
10. Run `code-review` against the captured fixed point and print both independent results. `standards_reviewer` checks whether the implementation satisfies the Product Spec. `spec_reviewer` checks whether the implementation satisfies the Architecture Spec. Pass both ticket-scoped Spec paths, wait for both reviewers, and keep the plan unresolved if either report is missing.
11. Only after both review results are available and resolved, set the local-markdown ticket status to `completed`. GitHub mode remains `In Progress` until the implementation PR merges.
12. Recalculate dependent tickets only after the implementation PR merges, the selected GitHub Issues are closed, and their Project `Workflow Status` is `Done`; otherwise keep dependents waiting.
13. Stop and report the updated statuses and whether the next plan can run.

## Rules

- GitHub mode must not write tracker status to local plan Markdown. local-markdown mode must not call `gh` or update a GitHub Project.
- Do not carry stale context across plans.
- Do not spawn or call a subagent for implementation work. `execution_runner` is allowed only for separate runtime verification and must not edit implementation files.
- This prohibition does not apply to the mandatory read-only `standards_reviewer` and `spec_reviewer` review agents required by step 12.
- Do not call another plan executor from inside implementation.
- Do not widen scope without reporting a blocker.
- GitHub mode에서 테스트·개발 중 새 Issue가 필요하면 `tracker.github.assignees.codex`를 `CODEX_ASSIGNEE`로 해석해 `--assignee "$CODEX_ASSIGNEE"`로 만든다. 기본값은 `@copilot`이다. 기존 Issue의 assignee는 명시적 요청 없이 변경하지 않는다.
- 구현 완료만으로 child Issue를 닫지 않는다. `gh-open-pr`가 PR 범위에 맞는 closing keyword를 넣고, PR merge 후 GitHub가 닫게 한다.
- After implementation PR merge, verify Issue closure and Project `Workflow Status` before updating and recalculating dependent ticket statuses in the selected tracker.
- Use `Planned`, `In Progress`, `Blocked`, and `Done` in GitHub Project mode; use `planned`, `in-progress`, `blocked`, and `completed` in local-markdown mode.
- If implementation cannot complete because of a blocker, set the selected tracker ticket to its blocked state and report the blocker.
- When implementing Java code, use Lombok to reduce boilerplate: apply `@Getter`, `@Setter`, and `@NoArgsConstructor` for the default constructor where compatible with the class design and project configuration.

PR creation is separate. Do not create a new branch or open a PR unless the user explicitly asks for that later.
