# Plan revision

`plan_revision` stage는 `context.producer_result_refs.plan_review`가 지정한 결과 파일과 `plan_review_result` 보고서 artifact를 읽고 reviewer findings를 canonical plan set에 반영한다.

작업 전에 `context.worktree_ref`의 정본 `worktree.json`을 읽어 작업 worktree, session과 `plan_set_id`를 확인한다. 기록이 없거나 ID가 없으면 중단한다. 해당 worktree의 `docs/plans/<plan-set-id>/`를 사용한다.

1. Finding마다 근거 파일·Spec ID·plan 경로를 확인한다. 누락된 동작, DDD owner 불일치, slice 경계·의존성 문제, 테스트 계약 또는 E2E 시점 문제를 지적된 범위에 반영한다.
2. 계획 수정이 승인된 Spec을 바꾸는 경우 `SPEC_REVISION_REQUIRED`와 근거를 orchestrator에 반환한다. plan 변경으로 해결 가능한 지적은 canonical plan·index·관련 Issue draft에 함께 반영한다.
3. reviewer의 승인된 범위 안에서 문서를 갱신하고 `{kind: "plan_set_revision", base: "workspace", path: "docs/plans/<plan-set-id>/plans.md"}` artifact와 수정 요약을 반환한다.
4. `completed/OK` 반환 뒤 orchestrator가 새 execution으로 `plan_review` stage를 다시 호출한다. Retry 횟수와 fresh reviewer 독립성은 [plan-review GUIDE](../../../.codex/internal-skills/plan-review/GUIDE.md)의 review attempt 절차로 관리한다.
