# 구현 workflow 조율

승인된 plan 집합을 구현할 때 최상위 orchestrator가 읽는다. 각 `implement-wrapper` 실행에는 선택된 plan 하나와 실제 작업 위치만 전달한다.

## 실행 배정

원본 프로젝트의 `<shared_guidance_root>/.codex/context-budget.json`과 plan의 예상 토큰을 읽는다. 계획이 현재 `max_plan_tokens`를 넘으면 `to-ticket` 단계로 돌아가 재분할한다. 실행 중 context 사용량을 판단할 때는 `harness-skill-execution.mjs budget --root <shared_guidance_root> --estimate <다음 작업 예상 토큰> --used <관측된 사용 토큰>`으로 `action_fits`를 확인한다. `used + estimate > context_window_tokens - handoff_reserve_tokens`이면 checkpoint 후 새 context로 재개한다. 관측 사용량이 없으면 정량 판정을 했다고 주장하지 않고 필요한 입력을 요청한다. worker가 Smart Zone을 재판단하지 않게 한다.

기존 scheduler가 반환한 `ready_plans`, `waiting_plans`, `parallel_groups`와 공유 자원 근거를 사용한다. 충돌·미확정 자원이 있으면 순차로, 독립 plan은 가용 동시 실행 수 안에서 병렬로 배정한다. plan별 실행 슬롯은 같은 plan의 중복 실행을 막는 단위다. 여러 plan의 슬롯은 동시에 실행할 수 있다.

순차 실행 위치·병렬 worktree 배정·통합·정리는 [session-worktree](../../../../.codex/internal-skills/session-worktree/GUIDE.md)의 선택된 방식에 따른다. worker에는 확정된 절대 `workspace_root`와 canonical `session_directory`를 전달한다. worker가 실행 방식을 다시 선택하거나 worktree를 생성하지 않게 한다.

runtime dispatch가 `plan_review`를 검사해 확인한 canonical plan·Spec 경로와 현재 review snapshot을 worker 입력에 넣는다. 계획·Spec·검증 profile이 바뀌어 승인이 stale이면 새 worker를 만들기 전에 해당 작성·리뷰 단계로 회귀한다. 기존 API의 `planSetId`는 이 gate 조회용 내부 식별자이며 worker가 경로를 재구성하는 입력이 아니다.

새 구현 orchestration의 `plan_set_id`는 선택한 `docs/plans/<plan-set-id>/plans.md`에서 가져와 workflow-compose의 새 worktree 입력에 전달한다. 병렬 배정은 같은 값을 `WorktreeManager.allocate`에도 전달해 각 worker의 `worktree.json`에 보존한다. 모든 implementer는 전달된 값과 reviewed plan 경로를 사용하며 새 ID를 고르지 않는다.

## Tracker

`.codex/harness.yaml`의 `tracker.mode`를 한 번 읽고 해당 절차만 적용한다.

- `github`: [GitHub tracker](../../implement-wrapper/references/tracker/github.md)
- `local-markdown`: [local-markdown tracker](../../implement-wrapper/references/tracker/local-markdown.md)

구현·리뷰·최종 완료의 승인 조건을 통과한 뒤 공통 tracker helper로 상태를 전이하고 Beads mirror를 검증한다. worker의 작업 완료와 plan·workflow의 완료를 구분한다.

## 리뷰·통합·완료

각 plan 구현과 단위 테스트 뒤 독립 구현 리뷰를 실행한다. 수정은 새 worker에 맡기고 원래 fixed point·review budget·checkpoint를 유지한다. Spec·계획 변경은 각각 해당 작성·리뷰 단계에 인계한다. 충돌 시 관련 실행을 멈추고 우선순위를 결정하며 활성 worker의 branch를 병합하지 않는다.

각 plan의 검증·리뷰·commit이 끝나면 실행 방식에 따라 통합하고 의존성을 재평가한다. 전체 plan 통합 뒤 parent test contract의 시나리오·oracle·profile·timeout·attempt budget으로 최종 feature-level E2E를 한 번 실행한다. 개별 plan 경계에서 E2E를 실행하지 않는다.

최종 E2E, plan-review completion, 승인된 제거 목록의 retirement, tracker sync, 계약 동기화와 cleanup gate가 모두 통과해야 최종 완료를 보고한다. plan set의 integration PR은 한 번만 작성·갱신하고 자동 merge하지 않는다. checkpoint·events·raw 실행 증거는 session에 보존하며 외부 tracker나 PR에 복사하지 않는다.
