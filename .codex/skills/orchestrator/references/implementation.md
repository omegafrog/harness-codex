# 구현 workflow 조율

승인된 plan 집합을 구현할 때 최상위 orchestrator가 읽는다. 각 `implement-wrapper` 실행에는 선택된 plan 하나와 실제 작업 위치만 전달한다.

## 실행 배정

활성 workspace의 `<workspace_root>/.codex/context-budget.json`과 plan의 예상 토큰을 읽는다. 계획이 현재 `max_plan_tokens`를 넘으면 `to-ticket` 단계로 돌아가 재분할한다. 실행 중 context 사용량을 판단할 때는 `harness-skill-execution.mjs budget --root <workspace_root> --estimate <다음 작업 예상 토큰> --used <관측된 사용 토큰>`으로 `action_fits`를 확인한다. `used + estimate > context_window_tokens - handoff_reserve_tokens`이면 checkpoint 후 새 context로 재개한다. 관측 사용량이 없으면 정량 판정을 했다고 주장하지 않고 필요한 입력을 요청한다. worker가 Smart Zone을 재판단하지 않게 한다.

기존 scheduler의 `ready_plans`, `waiting_plans`와 dependency 근거를 사용하되 한 번에 split plan 하나만 배정한다. 독립 plan이나 `parallel_groups`가 있어도 병렬 dispatch하지 않는다. 진행 중인 plan은 기존 checkpoint에서 재개하고, 해당 plan의 구현·단위 테스트·독립 리뷰·canonical tracker 완료 확인까지 끝나야 다음 ready plan을 선택한다. blocked/failed 또는 사용자 결정 대기 중이면 다음 plan을 시작하지 않는다.

순차 실행 위치·통합·보존은 [session-worktree](../../../../.codex/internal-skills/session-worktree/GUIDE.md)의 sequential 방식을 따른다. worker는 정본 `worktree_ref`에서 작업 위치와 session을 읽는다. worker가 실행 방식을 다시 선택하거나 worktree를 생성하지 않게 한다.

runtime dispatch가 `plan_review`를 검사해 확인한 canonical plan·Spec 경로와 현재 review snapshot을 worker 입력에 넣는다. 계획·Spec·검증 profile이 바뀌어 승인이 stale이면 새 worker를 만들기 전에 해당 작성·리뷰 단계로 회귀한다. 기존 API의 `planSetId`는 이 gate 조회용 내부 식별자이며 worker가 경로를 재구성하는 입력이 아니다.

구현은 정본 `worktree.json`의 `plan_set_id`와 reviewed plan 경로를 재사용하며 새 ID나 별도 executor를 만들지 않는다.

## Tracker

`.codex/harness.yaml`의 `tracker.mode`를 한 번 읽고 해당 절차만 적용한다.

- `github`: [GitHub tracker](../../../../.codex/internal-skills/implement-wrapper/references/tracker/github.md)
- `local-markdown`: [local-markdown tracker](../../../../.codex/internal-skills/implement-wrapper/references/tracker/local-markdown.md)

구현·리뷰·최종 완료의 승인 조건을 통과한 뒤 공통 tracker helper로 상태를 전이하고 Beads mirror를 검증한다. worker의 작업 완료와 plan·workflow의 완료를 구분한다.

## 리뷰·통합·완료

첫 plan dispatch 전 통합 리뷰 기준 HEAD를 기존 session/checkpoint에 보존하며 재개 시 재설정하지 않는다. 각 plan 구현 worker가 `REVIEW_REQUIRED`로 반환하면 구현 context를 공유하지 않는 fresh `standards_reviewer`·`spec_reviewer`로 [code-review](../../../../.codex/internal-skills/code-review/GUIDE.md)를 실행한다. 구현 worker가 자기 diff를 리뷰하거나 리뷰 pass를 대신 보고한 결과는 리뷰로 인정하지 않는다. 수정은 새 worker에 맡기고 재리뷰도 새 fresh reviewer가 수행하며 원래 fixed point·review budget·checkpoint를 유지한다. Spec·계획 변경은 각각 해당 작성·리뷰 단계에 인계한다. 구현자가 신고했거나 리뷰가 찾은 Spec 밖 동작은 수정이나 계획 변경으로 보내기 전에 사용자에게 유지/제거를 묻는다. 결함처럼 표현해 승인을 구하지 않고, 승인 Spec에 없는 동작이라는 점과 얻는 것·비용을 그대로 전달한다. plan만 고쳐 새 규칙을 넣지 않는다. 두 리뷰가 끝나면 다음 라우팅 전에 `code-review`의 `harness-code-review.mjs repair`를 반드시 실행하고 그 결과로만 수정·질문·Spec 인계를 정한다. `spec-me`로 넘길 때 사용자 답을 요약하며 "위임"으로 바꾸지 않는다. 리뷰가 요구한 새 결정은 사용자 답 없이 `spec-me`나 `to-ticket`으로 보내지 않는다. 수정 한도 소진은 Spec·plan 변경의 사유가 아니다. 사용자에게는 결과의 `user_questions[].question`을 그대로 제시한다. 권장안을 바꾸거나 질문을 다시 쓰지 않는다. 충돌 시 관련 실행을 멈추고 우선순위를 결정하며 활성 worker의 branch를 병합하지 않는다.

각 plan의 검증·리뷰·commit이 끝나면 순차 workspace에서 통합하고 canonical tracker 완료 상태를 재조회한 뒤 의존성을 재평가한다. tracker 조회 실패나 mirror 불일치는 완료로 간주하지 않는다.

모든 split plan의 구현이 끝나면 기존 `code-review`를 전체 누적 diff에 대해 다시 수행한다. 기준점은 첫 split plan 구현 직전 HEAD이며, 마지막 통합 commit·전체 canonical plan·Product/Architecture Specs·요구별 구현/검증 근거를 두 독립 reviewer에게 전달한다. Standards는 Product의 UC/BR/AC 누락·오동작을, Spec은 Architecture의 규칙 owner·경계·통신·저장 계약을 실제 코드와 대조한다. plan별 pass로 통합 리뷰를 대체하지 않는다. blocking finding 또는 누락·stale Spec/리뷰가 있으면 E2E로 넘어가지 않는다. 수정은 기존 code-review의 수정/설계 인계·횟수 제한을 유지한다.

## 최종 E2E 승인과 실패 처리

1. canonical tracker에서 대상 plan set의 모든 split plan 완료와 통합 리뷰 pass를 확인한다. 여러 plan set이 요청 범위에 있으면 대상 전체가 이 조건을 만족한 뒤 최종 E2E를 준비한다. child 완료와 parent feature 완료를 구분하며 E2E 전 parent 완료를 선언하지 않는다.
2. 에이전트가 승인 Product/Architecture Specs와 parent test contract를 읽고 실제 엔드유저 E2E 시나리오를 작성한다. 각 시나리오에 요구 ID, 준비 데이터·실제 서버/인프라, 사용자 행동, 관측할 기대 결과/실패 조건, 실행 profile·timeout과 cleanup을 포함한다. 계획과 다른 실행 조건은 차이와 사유를 표시하며 승인 Spec 변경은 해당 설계/계획 단계로 돌린다.
3. 완성된 시나리오를 한국어로 사용자에게 보여주고 최종 실행 승인을 요청한다. 기존 질문/답변 계약으로 `USER_DECISION_REQUIRED`를 반환하고 시나리오 파일·대상 commit·실행 조건과 실제 답변 참조를 session에 보존한다. 구현 진행 승인이나 과거 계획 승인을 E2E 실행 승인으로 간주하지 않는다. 응답 대기·거절 중에는 서버/인프라와 runner를 시작하지 않는다. 시나리오·대상 코드·실행 조건이 바뀌면 변경본을 다시 승인받는다.
4. 명시적 승인 뒤에만 기존 `e2e-test`와 `e2e_test_runner`를 호출한다. 승인된 시나리오·oracle·profile·budget과 답변 참조를 전달한다. 개별 plan 경계에서 E2E를 실행하지 않는다.
5. 테스트 실패·timeout·환경 차단·cleanup 실패 시 증거와 실패 이력을 보존하고 소유 프로세스/산출물 cleanup만 수행한다. 제품 코드·테스트·assertion·실행 설정을 자동 수정하지 않고 재실행하지 않는다. 실패 시나리오, 기대/실제 결과, 로그/스크린샷/receipt, 원인 가설, 제안 수정과 재실행 범위를 사용자에게 제시하고 `USER_DECISION_REQUIRED`로 반환한다. 사용자가 허용한 조치만 수행하며 수정 승인과 재실행 승인을 구분한다.

최종 완료 전에 [sync-contracts](../../../../.codex/internal-skills/sync-contracts/GUIDE.md)로 통합 계약을 갱신·seal한다. 최종 E2E, plan-review completion, 승인된 제거 목록의 retirement, tracker sync, 계약 동기화와 cleanup gate가 모두 통과해야 최종 완료를 보고한다. plan set의 integration PR은 한 번만 작성·갱신하고 자동 merge하지 않는다. checkpoint·events·raw 실행 증거는 session에 보존하며 외부 tracker나 PR에 복사하지 않는다.
