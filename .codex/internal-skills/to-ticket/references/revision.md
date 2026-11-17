# Ticket revision

같은 `to-ticket` execution이 내부 독립 reviewer의 기록된 verdict가 `revise`일 때 이 절차를 수행한다. Canonical review record와 finding 근거를 읽고 plan set에 반영한다.

작업 전에 `context.worktree_ref`의 정본 `worktree.json`을 읽어 작업 worktree, session과 `plan_set_id`를 확인한다. 기록이 없거나 ID가 없으면 중단한다. 해당 worktree의 `docs/plans/<plan-set-id>/`를 사용한다.

1. Finding마다 근거 파일·요구 ID(BIZ·INV·EX·AC)·tactical-design 절·ticket 경로를 확인한다. 누락된 규칙 소유, 모델 소유자 불일치, 컨텍스트 경계(6절) 위반, ticket 경계·의존 순서 문제, 검증 테스트 누락을 지적된 범위에 반영한다.
2. 수정이 `requirements.md`에 없는 규칙을 더하거나 규칙을 더 엄격하게 만드는 경우 `SPEC_REVISION_REQUIRED`와 근거를 orchestrator에 반환해 요구사항을 먼저 고친다. "요구사항은 유지하고 ticket만 수정"이라는 지시나 사용자 승인이 있어도 같다. 설계 문서의 빈칸이면 `blocked/DEPENDENCY_INCOMPLETE`로 `result.owner_stage`와 `result.dependency_gap`을 적어 다시 열 stage를 가리킨다(orchestrator가 사용자 질문 없이 그 stage부터 순서대로 다시 진행한다). ticket 변경으로 해결 가능한 지적은 canonical ticket·index·관련 Issue draft에 함께 반영한다.
3. reviewer가 지적한 범위 안에서 문서를 갱신하고 `{kind: "plan_set_revision", base: "workspace", path: "docs/plans/<plan-set-id>/plans.md"}` artifact와 수정 요약을 반환한다.
4. 수정 뒤 [plan-review GUIDE](../../plan-review/GUIDE.md)의 attempt 절차에 따라 새로운 독립 reviewer로 재검토한다. 내부 리뷰 handoff를 반환하지 않는다. 단 Claude Code stage는 reviewer를 직접 띄울 수 없으므로 [review-routing](review-routing.md)의 `REVIEW_REQUIRED` handoff를 사용한다.
