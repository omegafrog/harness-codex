<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Plan Review

## 기준

최초 독립 리뷰는 요청 원문, Product Spec, Architecture Spec, 관련 결정·다이어그램·현행 계약과 모든 canonical plan을 직접 읽고 대조한다. 재리뷰는 아래 변경 범위 규칙을 따른다. Spec의 동작·제약·DDD 경계, 각 slice의 `max_plan_tokens`, plan 간 의존·인계, 업무 규칙 단위 테스트와 통합 후 단일 feature E2E 계약을 검토한다.

자동 검사는 전체 입력 snapshot과 이전 내용을 보존한다. 최초 리뷰는 전체를 읽고, 재리뷰는 `review_delta`의 변경 구간, 미해결 지적과 직접 영향을 받는 Spec·plan 관계만 새 reviewer가 확인한다. 이전에 통과한 무관한 항목은 유지한다. 이전 내용이 없거나 구간이 모호하면 해당 파일을 전체 검토한다. 변경 영향 판단은 reviewer가 수행하며 전체 snapshot gate는 계속 현재성을 확인한다.

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정한 tier가 있으면 그 값을 우선한다. caller는 작성자 맥락을 상속하지 않는 fresh reviewer를 생성하고 실제 reviewer/context ID 및 author IDs를 보존한다. reviewer는 읽기 전용으로 검토하고 전체 결과를 Codex session response에 inline 반환한다. pass/revise 판정과 findings 요약은 `runtime/executions/<execution_id>/plan-review.md` artifact에도 작성한다.

## Workflow stage 절차

1. 각 `plan_review` stage 실행 전에 orchestrator는 새 `harness-plan-review.mjs begin --root <workspace_root> --plan-set <plan-set-id>`를 실행해 attempt ID와 검토 snapshot을 만든다. Attempt와 snapshot 입력을 새 read-only `plan_reviewer` 실행에 전달한다.
2. 새 `plan_reviewer`는 위 기준 문서와 Smart Zone 설정을 직접 읽고 pass 또는 revise 판정과 구체적인 finding 근거를 반환한다. `details.inputs`는 orchestrator가 전달한 begin admission snapshot hash를 그대로 사용한다. `reviewer_id`는 현재 reviewer execution ID, `author_ids`는 session `state.json`의 `plan_split` 및 모든 `plan_revision` execution ID 목록, `fork_turns`는 `none`으로 기록한다. Stage 결과의 `details`에는 `attempt_id`, `verdict`, `inputs`, `findings`, `reviewer_id`, `author_ids`, `fork_turns`를 기록하고 `artifacts`에는 `{kind: "plan_review_result", base: "session", path: "runtime/executions/<execution_id>/plan-review.md"}`를 제공한다. Reviewer 실행은 findings 판정이 pass/revise일 때 `completed/OK`로 끝나며 verdict는 `details.verdict`가 나타낸다. 입력·환경 차단은 해당 blocked/failed 코드를 반환한다.
3. Orchestrator는 result의 `details`를 같은 Codex session에서 읽고 실제 reviewer metadata와 plan 작성 execution ID를 결합해 review JSON을 저장하고 `harness-plan-review.mjs record --root <workspace_root> --plan-set <plan-set-id> --attempt <attempt_id> --reviews <session-relative JSON>`로 기록한다. `pass`면 `harness-plan-review.mjs check --root <workspace_root> --plan-set <plan-set-id> --phase planning`을 실행하고 `plan_finalize`를 선택한다. `revise`면 result artifact를 `plan_revision`에 전달한다.
4. `plan_revision` 완료 뒤 orchestrator는 새 execution으로 `plan_review` stage를 반복한다. 각 회차는 fresh reviewer와 새 attempt를 사용한다. 최대 3회차 뒤 미해결 finding은 scope/decision을 사용자에게 묻는 반환으로 전환한다.
5. Finalize와 완료 시 같은 snapshot gate가 현재 Spec·plan을 확인한다. Spec이나 plan이 바뀌면 변경 구간과 영향받는 관계를 fresh reviewer가 검토하고 새 snapshot을 기록한다.
