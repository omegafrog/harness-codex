---
name: implement
description: Execute one approved split plan at a time, with fresh context, tests first, and strict scope control.
---

# implement

Before editing code, activate the installed Ponytail plugin's `ponytail` skill in its default `full` mode and follow its minimal-change guidance throughout implementation. If it is unavailable, stop and report the missing/disabled plugin instead of silently proceeding without it.

## Flow

작업 경로 계약: `implement-wrapper`가 전달한 절대 `workspace_root`를 사용한다. 새 명령마다 그 경로를 working directory로 지정하고, 저장소 파일을 읽거나 수정하기 전에 `pwd`와 `git rev-parse --show-toplevel`이 일치하는지 검증한다. 실제 E2E runner에도 같은 루트를 전달하며, 완료 결과에 검증된 경로를 보고한다. 병렬 구현 worktree라면 `workspace_branch`도 확인해 그 브랜치에 구현 커밋을 남기고 완료 결과에 브랜치명을 보고한다.

1. Read `.codex/harness.yaml` and resolve the selected tracker mode. Before implementation dispatch, require an actual `agents.implementation_model` value; before runtime/E2E verification, resolve and explicitly pass actual `agents.execution_model` and `agents.execution_reasoning_effort` values. Missing values stop the workflow and require `setup`; never inherit the parent model.
2. Resolve exactly one approved, executable split plan:
   - GitHub Issues: select a child Issue from the parent plan-set Issue, move its configured GitHub Project `Workflow Status` to `In Progress`, and use its Issue body as the plan.
   - local-markdown: resolve one ticket from the configured directory and set its status to `in-progress`; confirm the plan-set's `docs/plans/<plan-set-id>/plans.md` links to the plan document.
3. Resolve the ticket-scoped Product Spec and Architecture Spec.
4. Read `docs/architecture/constraints.md` when present, then reload the current spec, resolved plan representation, and Git state.
5. Read the explicit `workspace_root` passed by `implement-wrapper`; do not infer it from a prior command or the parent session's default directory. Set every command's working directory to that root and verify `pwd` plus `git rev-parse --show-toplevel` before reading or editing plan files. Stop before editing if they do not match. Capture the pre-implementation `HEAD` there as the code-review fixed point, then execute the plan in that workspace.
6. Write the failing test for the agreed seam first.
7. Implement the minimum code needed to pass.
8. Run the plan-specific test set and typecheck from `workspace_root`. If the plan requires actual E2E or server execution, invoke the E2E test workflow with the same `workspace_root`, resolved model ID, and reasoning effort (not literal config keys); wait for its polling result before completion. Include the verified `workspace_root` in the implementation result.
9. Commit the result. A split plan never creates or updates its own PR. Do not set terminal tracker status before both independent review results pass.
10. `review_fixed_point`는 구현 시작 직전 캡처한 `HEAD`다. `code-review`를 이 fixed point에 대해 실행하고 Standards·Spec 두 독립 결과를 모두 수집한다. `standards_reviewer`에는 ticket-scoped Product Spec을, `spec_reviewer`에는 ticket-scoped Architecture Spec을 전달한다.
11. 어느 리뷰든 blocking finding, 미해결 blocker 또는 누락된 결과가 있으면 plan을 완료하지 않는다. 리뷰가 아직 실행 중이면 완료될 때까지 기다린다. reviewer 실행 실패나 최종 결과 누락이면 같은 commit·fixed point·Spec 입력으로 해당 리뷰를 fresh reviewer context에서 재시도한다. 재시도도 reviewer 실행 환경 문제로 실패하면 외부 blocker로 기록하고 선택한 tracker를 `Blocked`로 전환한다. 코드로 해결할 수 있는 finding은 구현 agent가 리뷰 보고서의 구체적 근거와 두 ticket-scoped Spec을 다시 읽고, 범위를 좁혀 수정한 뒤 focused verification을 실행한다. 수정은 새 commit으로 남기고, 동일한 `review_fixed_point`부터 누적 diff 전체를 다시 `code-review`에 전달해 두 리뷰를 모두 재실행한다. 두 리뷰의 모든 blocking finding이 해소되고 두 결과가 모두 최신 commit을 판정할 때까지 반복한다. 이전 리뷰에서 지적된 항목을 수정하지 않기로 판단하면 그 근거와 관련 Spec 조항을 기록하고 reviewer가 이를 더 이상 blocker로 보지 않는다는 확인을 받아야 해소로 인정한다.
12. 리뷰 수정이 다음 한 작업으로 Smart Zone을 넘을 것 같으면 현재 commit·두 리뷰 보고서·미해결 finding·focused verification 증거·`review_fixed_point`·Product/Architecture Spec 경로·정확한 다음 작업을 checkpoint에 기록한다. 현재 agent는 중지하고, fresh-context 구현 agent가 같은 plan slot에서 이를 읽어 진단·수정·검증·commit을 이어간 뒤 같은 fixed point 기준으로 두 리뷰를 다시 실행한다. context 한도만으로 ticket을 `Blocked` 처리하지 않는다.
13. 해결에 필요한 외부 환경, 권한, 의존성 또는 사용자/아키텍처 결정이 막혀 있으면 해당 리뷰 finding과 필요한 입력·정확한 unblock condition을 checkpoint 및 결과에 기록하고 선택한 tracker에서 ticket을 `Blocked`로 전환한다. 입력이 해결되기 전에는 수정·재리뷰가 가능하다고 가장하거나 완료 처리하지 않는다.
14. 모든 blocking finding이 해소되고 두 리뷰 결과가 현재 commit에 대해 모두 통과한 뒤에만 선택한 ticket을 terminal state로 설정한다: GitHub mode는 `Done`, local-markdown mode는 `completed`. GitHub mode에서는 child Issue를 열어 둔 채 configured `Workflow Status` Project field만 `Done`으로 갱신하고, 보고 전에 그 field가 `Done`인지 확인한다.
15. Recalculate dependent tickets as soon as their dependencies reach those terminal states. Keep only incomplete or unresolved tickets waiting.
16. Stop and report the updated statuses and whether the next plan can run. Invoke or recommend `gh-open-pr` exactly once only when every split plan in the plan set has passed verification and reached its terminal status; create or update the single plan-set implementation PR. Do not merge the PR automatically.

## Rules

- GitHub mode must not write tracker status to local plan Markdown. local-markdown mode must not call `gh` or update a GitHub Project.
- Plan runtime checkpoint artifacts under `docs/plans/.runtime/` are local-only and gitignored. Never upload, publish, or copy `checkpoint.md` or `events.jsonl` to GitHub Issues, comments, Project fields, PR bodies, commits, or pushes.
- Do not carry stale context across plans.
- Do not spawn or call a subagent for implementation work. `execution_runner` is allowed only for separate runtime verification and must not edit implementation files.
- This prohibition does not apply to the mandatory read-only `standards_reviewer` and `spec_reviewer` review agents required by step 12.
- Do not call another plan executor from inside implementation.
- Do not widen scope without reporting a blocker.
- GitHub mode에서 테스트·개발 중 새 Issue가 필요하면 `tracker.github.assignees.codex`를 `CODEX_ASSIGNEE`로 해석해 `--assignee "$CODEX_ASSIGNEE"`로 만든다. 기본값은 `@copilot`이다. 기존 Issue의 assignee는 명시적 요청 없이 변경하지 않는다.
- 구현 완료한 split plan은 child Issue를 닫지 않되 Project `Workflow Status`를 `Done`으로 전환한다. `gh-open-pr`는 모든 split plan 완료 후 하나의 plan-set integration PR에만 closing keyword를 넣는다.
- GitHub 완료 상태는 `.codex/harness.yaml`의 `tracker.github.status_field`에 해당하는 Project field에만 기록한다. 기본 Project `Status` field를 대신 갱신하지 않는다.
- GitHub mode status mutation은 아래 순서를 따른다. `Workflow Status` field ID, `Done` option ID, child Issue의 Project item ID를 먼저 resolve한 뒤 `gh project item-edit`로 `--single-select-option-id`를 설정한다. 실행 후 `gh project item-list`로 configured field가 `Done`인지, `gh issue view`로 child Issue가 `OPEN`인지 verify한다. 어느 검증이든 실패하면 완료 보고·dependent 재계산을 중단한다.

  `PROJECT_OWNER`, `PROJECT_NUMBER`, `STATUS_FIELD_NAME`, `ISSUE_NUMBER`, `REPOSITORY`는 `.codex/harness.yaml`과 선택한 child Issue에서 resolve한다.

  ```bash
  PROJECT_ID=$(gh project view "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json --jq '.id')
  STATUS_FIELD_ID=$(gh project field-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json --jq ".fields[] | select(.name == \"$STATUS_FIELD_NAME\" and .type == \"ProjectV2SingleSelectField\") | .id")
  DONE_OPTION_ID=$(gh project field-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json --jq ".fields[] | select(.name == \"$STATUS_FIELD_NAME\").options[] | select(.name == \"Done\") | .id")
  ITEM_ID=$(gh project item-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json --limit 100 --jq ".items[] | select(.content.number == $ISSUE_NUMBER) | .id")
  gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" --field-id "$STATUS_FIELD_ID" --single-select-option-id "$DONE_OPTION_ID"
  ACTUAL_STATUS=$(gh project item-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json --limit 100 --jq ".items[] | select(.content.number == $ISSUE_NUMBER) | .[\"$STATUS_FIELD_NAME\"]")
  test "$ACTUAL_STATUS" = "Done"
  ISSUE_STATE=$(gh issue view "$ISSUE_NUMBER" --repo "$REPOSITORY" --json state --jq .state)
  test "$ISSUE_STATE" = "OPEN"
  ```
- Recalculate dependent tickets after their dependency reaches its terminal tracker status, not after the plan-set PR merges.
- Use `Planned`, `In Progress`, `Blocked`, and `Done` in GitHub Project mode; use `planned`, `in-progress`, `blocked`, and `completed` in local-markdown mode.
- If implementation cannot complete because of a blocker, set the selected tracker ticket to its blocked state and report the blocker.
- When implementing Java code, use Lombok to reduce boilerplate: apply `@Getter`, `@Setter`, and `@NoArgsConstructor` for the default constructor where compatible with the class design and project configuration.

PR creation remains a separate `gh-open-pr` step. Do not create or update a PR at an individual split-plan boundary. Once every split plan is fully complete and both reviews are resolved, create or recommend exactly one plan-set integration PR. Do not create a new branch or open a PR before that point, and do not merge the PR automatically.
