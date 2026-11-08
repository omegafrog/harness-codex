<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# implement

구현은 이 실행이 수행하고 필수 독립 리뷰는 서브에이전트에 위임한다.

구현 전 workspace 확인은 workflow runtime dispatch의 `before_dispatch` workspace gate가 수행한다. skill 절차와 구현 agent는 `harness-workspace-preflight.mjs`를 별도로 실행하지 않는다. gate 실패는 spawn을 막고 정확한 결과를 caller에게 반환한다. 구현 agent는 setup 복구 절차를 호출하지 않는다.

## 작업 위치

`implement-wrapper`가 전달한 절대 `workspace_root`에서 구현하고 모든 명령의 cwd로 지정한다. 이전 명령이나 부모 세션의 기본 디렉터리에서 추정하지 않는다. 파일 접근 전에 `pwd`와 `git rev-parse --show-toplevel`을 대조하고 다르면 편집 전에 멈춘다. 완료 결과에 확인한 루트와 브랜치를 보고한다. 소유 worktree 정보는 `session_directory/worktree.json`에 있으며 순차/병렬 배정과 worktree 생성·통합·종료는 orchestrator가 맡는다. 구현 worker는 실행 방식을 다시 고르거나 lifecycle 정보를 중복 전달하지 않는다.

## 읽을 문서

- 편집 전 `<workspace_root>/docs/agents/implementation-guidance.md`, 테스트를 계획·작성·선택·실행하기 전 `<workspace_root>/docs/agents/testing-guidance.md`와 [test-writing guidance](../testing-guidance/GUIDE.md). 이 파일들은 활성 workspace의 프로젝트 memory이며 managed workflow에서 원본 checkout의 사본으로 대체하지 않는다. 범위 안의 지침만 적용하고 승인 Spec·실행 계약과 충돌하면 진행 전에 보고한다.
- 영향받는 [model continuity contract](../ddd-design/references/model-continuity.md), plan의 [execution evidence contract](../../../.codex/internal-skills/to-ticket/references/execution-evidence.md), [공통 검증 정책](../../../.codex/internal-skills/e2e-test/references/verification-policy.md).
- `docs/architecture/constraints.md`(있으면)와 `docs/contracts/` 현행 계약. 계약 갱신·seal은 [sync-contracts](../../../.codex/internal-skills/sync-contracts/GUIDE.md)에 따라 최종 구현 workflow만 수행한다. 개별 plan의 contract snapshot drift는 deferred로 기록하고 구조 오류·실행 준비 실패는 차단한다.

## Flow

1. `.codex/harness.yaml`에서 tracker mode를 확인한다. 구현 dispatch 전에는 실제 `agents.implementation_model` 값이, runtime/E2E 검증 전에는 `agents.execution_model`과 `agents.execution_reasoning_effort` 값이 있어야 한다. 값이 없으면 workflow를 멈추고 `setup`이 필요하다고 보고하며 부모 모델을 상속하지 않는다.
2. 승인되어 실행 가능한 split plan 하나를 정하고 [Tracker 상태](#tracker-상태)에 따라 `in-progress`로 전환한다.
   - GitHub Issues: parent plan-set Issue의 child Issue를 고르고 Issue 본문을 plan으로 사용한다.
   - local-markdown: `docs/plans/<plan-set-id>/<plan-id>.md`를 ticket으로 읽고 `docs/plans/<plan-set-id>/plans.md`가 링크하는지 확인한다.
3. 통과한 plan-review gate가 선택한 정확한 canonical plan과 ticket-scoped Product·Architecture Spec을 읽는다. plan의 test contract가 비즈니스 로직 단위 테스트와 검증을 정하며 다른 test suite를 추정하지 않는다. 누락·stale planning review는 dispatch를 막는다. ticket 존재, canonical tracker 상태, planning-review 승인을 구분한다. 상태 조회 실패나 dirty/uncommitted Spec은 ticket이나 승인 plan이 없다는 증거가 아니다. 누락·stale 입력은 정확히 인용하고 별도 cleanliness 규칙은 그 증거와 함께 보고한다.
4. 구현 직전 `HEAD`를 `review_fixed_point`로 캡처한다. 기존 model/owner와 요구 ID를 확인하고 관련 변경 전 baseline을 기록하며 현행 public domain operation을 사용한다. 승인된 경계 근거 없는 새 module/scaffolding은 만들지 않는다.
5. 승인된 Product Spec의 UC/BR/AC와 Architecture Spec의 규칙 owner를 확인해 변경할 비즈니스 로직을 정한다.
6. 승인 Spec을 만족하는 최소 구현을 진행한다. 규칙이 세부를 정하지 않았으면 충분한 수준 안에서 가장 단순한 플랫폼 기본 동작을 쓴다. 없을 때 의도가 깨지는 구체적인 상황을 말할 수 없는 동작은 넣지 않는다. 정규화·인코딩 기준 계산·locale 처리·추가 검증·재시도·새 옵션은 구현 세부가 아니라 동작이다. 요구 ID로 연결되지 않는 동작은 커밋 전에 제거하고, 남겨야 한다고 판단하면 완료 결과의 `unplanned_additions`에 `{id, summary, evidence, benefit, cost, rule_impact, plain_explanation}`로 신고한다. `rule_impact`는 업무 규칙·제한·검증·상태·데이터 동작을 더하지 않을 때만 `none`이다. 실행 안내와 테스트 fixture는 신고 대상이 아니다. 없으면 빈 배열을 반환한다. 신고한 항목은 사용자가 유지 또는 제거를 정하기 전까지 완료를 막는다.
7. 이 split plan이 소유한 규칙의 비즈니스 로직 단위 테스트만 작성·갱신한다. 중요한 업무 결과를 검증하고 무관한 type/format 실패를 나열하지 않는다. 외부 의존성은 mock한다. 테스트는 다른 테스트·순서·공유 가변 상태에 의존하지 않는다. 비즈니스 로직이 바뀌었으면 plan의 단위 테스트를 이 slot에서 실행하고, 바뀌지 않았으면 단위 테스트를 추가하지 않는다.
8. 리뷰된 ledger의 verification contract에 있는 native CLI 명령을 그대로 실행하고 모든 `verification_file`을 포함하는지 확인한다. 비테스트 process gate는 테스트 작성과 구분하고, 실행·생략한 검증을 사유와 함께 보고한다. 개별 plan 경계에서 feature-level E2E를 실행하지 않는다. 검증·측정 결과는 기존 checkpoint `tests` payload에 보존해 두 reviewer에게 전달한다.
9. `git add`나 `git commit`을 실행하지 않는다. Codex sandbox는 write root와 무관하게 linked worktree의 `.git`을 막는다. 정확한 파일 목록으로 `commit_request: {message, paths}`를 반환하면 stage runner가 stage 종료 후 commit하고 `commit_sha`를 기록한다.
10. `code-review`를 `review_fixed_point`에 대해 실행해 Standards·Spec 두 독립 결과를 모두 수집한다. `standards_reviewer`에는 ticket-scoped Product Spec을, `spec_reviewer`에는 ticket-scoped Architecture Spec을 전달한다. 이 두 read-only reviewer는 아래 subagent 금지의 예외다.
11. 두 결과에 `code-review`의 수정 판정 절차를 적용하고, 수정이나 사용자 결정 요청 전에 [공통 리뷰 조정](../review-coordination/GUIDE.md)을 적용한다. 실행 중인 reviewer는 기다리고, 종료·누락된 reviewer는 사유를 보존해 같은 commit·fixed point의 fresh context에서 한 번 재시도한다. 구현 finding은 두 축의 지적을 모아 해당 규칙의 최초 요청·후속 요청·직접 API·재시도·저장 복구 경로와 검증 증거를 함께 확인한다. 수정 전에 `harness-code-review.mjs repair`로 plan별 수정 횟수를 예약하고 허용된 범위의 코드·테스트를 함께 고친다. 새 commit 뒤 원래 `review_fixed_point`부터 누적 diff를 서로 다른 fresh reviewer 2명이 검토한다. 기본 수정 한도는 1회이며 승인된 설정은 최대 2회다. 한도·요구 충돌·설계 결정 문제는 남은 지적과 필요한 결정을 사용자에게 제시하고 중단한다. 한도 초기화는 실제 수정 범위/설계 결정을 바꾸고 새 planning snapshot이 독립 검토·dispatch 검사를 통과한 경우에만 허용한다. “계속 해” 같은 일반 진행 지시는 초기화 근거가 아니다. 자동 판정이 repair adapter를 사용하면 동일 예약 처리가 실행기에 연결된다.
12. 분기와 중단:
    - 추가 작업이나 계획 범위 변경이 필요하면 현재 commit·리뷰 보고서·미해결 finding·검증 증거·`review_fixed_point`와 다음 작업을 checkpoint에 보존하고 공통 상태 코드로 반환한다. 재분할·재실행·context 인계는 orchestrator가 정한다.
    - finding이 새 명령·업무 상태·규칙·경계 또는 승인 Spec 변경을 요구하거나, 승인 Spec에 없는 제품·업무 규칙이나 설계 결정을 발견하면 구현을 중단한다. 현재 commit·fixed point·변경 근거·영향 경로·재개 조건을 checkpoint에 보존하고 `action_required/SPEC_REVISION_REQUIRED`로 상위 orchestrator에 반환한다. 구현 단계에서 직접 사용자에게 결정 질문을 하거나 임의로 정하지 않는다. orchestrator가 `spec-me`에서 결정하고 `to-ticket`이 영향 계획을 재검토한 뒤 승인 결과로 재개한다. 구현 repair 예약은 수정 범위가 승인된 뒤 수행한다.
    - 외부 환경·권한·의존성·사용자/아키텍처 결정이 막혀 있으면 finding, 필요한 입력, 정확한 unblock condition을 checkpoint와 결과에 기록하고 ticket을 `blocked`로 전환한다. 입력이 해결되기 전에는 수정·재리뷰가 가능하다고 가장하거나 완료 처리하지 않는다.
13. 구현·검증 결과와 선택한 실행 profile의 성공 receipt를 기존 session evidence에 기록한다. Receipt는 session runtime 경로에서 읽으며 profile/config/file hash가 현재 파일과 맞아야 한다.
14. 모든 blocking finding이 해소되고 두 리뷰 결과와 `plan-review` completion gate(Spec·전체 계획의 review snapshot 최신 여부)가 현재 commit에 대해 통과한 뒤에만 ticket을 `completed`로 전환한다. 의존 ticket은 의존성이 terminal 상태가 되는 즉시 재계산하며 plan-set PR merge를 기다리지 않는다. 미완료·미해결 ticket만 대기시킨다.
15. 갱신한 상태와 다음 plan의 실행 가능 여부를 보고하고 멈춘다.

## Tracker 상태

- 상태 이름: GitHub Project `Planned`·`In Progress`·`Blocked`·`Done`, local-markdown `planned`·`in-progress`·`blocked`·`completed`.
- 모든 전이는 `beads` 스킬의 공통 `node .codex/scripts/harness-tracker.mjs sync --root "$WORKSPACE_ROOT" --ticket <ref> --status <in-progress|blocked|completed> [--phase implementation|test|review] [--classification committed]`로 수행한다. canonical을 먼저 갱신하고 Beads mirror를 반영·재조회한다. 개별 gh/bd 상태 명령을 조립하지 않는다. 테스트·리뷰 시작은 lifecycle `in-progress`를 유지한 채 `--phase test`·`--phase review`로 기록한다. version marker가 없는 기존 데이터는 이전·자동 연결하지 않는다.
- GitHub mode는 `.codex/harness.yaml`의 `tracker.github.status_field` Project field에만 기록하고 기본 `Status` field나 local plan Markdown을 갱신하지 않는다. child Issue는 닫지 않는다. 완료 보고 전 `harness-tracker.mjs read --root "$WORKSPACE_ROOT" --ticket "$REPOSITORY#$ISSUE_NUMBER"`에서 `status: pass`, `canonical_status: completed`, `issue_state: OPEN`을 확인하고, 다르거나 읽기에 실패하면 완료 보고·dependent 재계산을 중단한다.
- local-markdown mode는 `gh`를 호출하거나 GitHub Project를 갱신하지 않는다.
- Beads sync 실패는 업무 실패와 구분하고 canonical 상태를 되돌리지 않는다. mirror sync blocker로 보고해 재시도할 수 있게 한다.
- GitHub mode에서 테스트·개발 중 새 Issue가 필요하면 `tracker.github.assignees.codex`를 `CODEX_ASSIGNEE`로 해석해 `--assignee "$CODEX_ASSIGNEE"`로 만든다. 기본값은 `@copilot`이다. 기존 Issue의 assignee는 명시적 요청 없이 바꾸지 않는다.

## Rules

- Before completion, check current/retired vocabulary and every old entrypoint whose caller moved. Remove consumer-free obsolete wrappers/exports/paths in scope, or report evidenced compatibility and removal conditions. Include UC/BR-to-owner/verification mapping and model-document disposition; passing feature tests alone does not complete a migration. Reconcile actual model/code and verification-map changes; do not relabel an accepted target as implemented before its behavior is verified.
- The approved removal list must pass the registered `retirement` lifecycle check against the actual workspace before completion. Report its verdict with the ordinary verification evidence. Missing disposition or a remaining approved-for-removal path cannot be treated as completed, even if feature tests or reviewer summaries say passed.
- Plan runtime checkpoint artifacts under `<session_directory>/runtime/plans/` are local-only. Never upload, publish, or copy `checkpoint.md` or `events.jsonl` to GitHub Issues, comments, Project fields, PR bodies, commits, or pushes.
- Do not carry stale context across plans, call another plan executor, or widen scope without reporting a blocker.
- Do not spawn or call a subagent for implementation work. `execution_runner` is allowed only for separate runtime verification and must not edit implementation files.
- A split plan never creates or updates a PR or branch. Only after every split plan has passed verification, reached its terminal status and resolved both reviews, invoke or recommend `gh-open-pr` once for the single plan-set integration PR; only that PR carries closing keywords. Never merge it automatically.
- When implementing Java code, reuse the project's Lombok convention where configured. Do not add blanket `@Setter` or public construction that bypasses aggregate/value-object invariants; use domain operations and the minimum visibility required by persistence.

## 소유 worktree

상위 workflow가 전달한 worktree를 그대로 쓰고 소유권·종료를 다루지 않는다. 직접 소유한 실행이면 [session-worktree](../../../.codex/internal-skills/session-worktree/GUIDE.md)를 따른다.

## 실행 산출물 경로

실행 중 생기는 로그·임시 파일·스크린샷은 [실행 산출물 경로](../../../.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md)를 따른다.

## E2E 실행 조건과 실패

최종 E2E에 필요한 앱 실행 방법·환경·시나리오가 확정되지 않았다면 구현 단계에서 사용자에게 확인하고 `docs/agents/EXEC.md`와 `docs/agents/execution.json`에 실제 실행 조건을 기록한다.

E2E 전·후에는 [공통 실패 학습 절차](../../../.codex/internal-skills/e2e-test/references/failure-learning.md)를 적용한다. caller가 runner의 모든 실패를 `tests.e2e_failures`로 checkpoint/완료 state에 반영하고, 기존 실패 이력을 최신 성공 요약에서 제거하지 않는다. 현행 lesson·예방 검사와 실패별 수정/재검증 증거를 fresh-context handoff 및 다음 실행에 전달한다. 현재 필수 테스트의 실패·미실행과 실제 미해결 blocker는 완료를 막는다. 과거 실패의 학습 분류·지침 갱신·예방 조치 검증 상태는 별도 pending으로 인계하며 테스트 결과나 완료 판정을 바꾸지 않는다. 최종 E2E 실패 후 caller는 자동 수정·재실행하지 않고 `USER_DECISION_REQUIRED`로 실패 근거와 제안 조치를 사용자에게 확인받는다. 실제 승인 뒤에만 허용된 EXEC/profile·제품/검사 수정과 재검증·lesson 반영을 수행한다.
