# Plan split

`plan_split` stage가 승인된 Product/Architecture Spec을 vertical plan으로 분할하고 review 입력을 만든다.

## 입력과 분석

1. 전달된 `<session_directory>/worktree.json`에서 `workspace`, `branch`, `head`, `return_root`, `plan_set_id`를 읽는다. `plan_set_id`는 `spec-me`가 feature name에서 생성해 canonical `worktree.json`에 한 번 바인딩한 값이어야 하며 없으면 중단한다. Tracker ticket ID와 같을 필요는 없다. `workspace`를 `workspace_root`로 사용하고 명령의 `cwd` 및 하위 agent/tool에 전달한다. 진입 시 `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --defer-tracker-sync --json`을 실행해 `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다.
2. 요청 원문, Product/Architecture Spec, 현행 `docs/contracts/`와 연결 다이어그램, 관련 System Target·accepted Architecture Decision을 읽는다. 전달된 Spec 경로를 우선하고, 별도 지정이 없으면 `docs/specs/<plan-set-id>/request.md`, `docs/specs/<plan-set-id>/product-spec.md`, `docs/specs/<plan-set-id>/architecture-spec.md`를 읽는다. split 경계·기존 owner·실행 전제를 Spec에서 판별할 수 있는 만큼 현재 코드 조사가 필요하면 `code-research`를 실행한다.
3. 원본 프로젝트의 `<shared_guidance_root>/.codex/context-budget.json`에서 `max_plan_tokens`를 읽는다. 로딩·구현·업무 규칙 단위 테스트·수정 근거를 포함해 각 plan 예상 토큰과 산정 근거를 기록하고, 각 plan이 한도 안에 들도록 나눈다. Architecture Spec에 material technology choice가 있으면 `system-targets.yaml`의 `decision_metadata.decision_layer_version: 1`과 Architecture Decision ID, 승인 `decision_evidence_complete` 및 `decision_review_complete` 결과를 확인한다.

## 분할 제안과 승인

각 vertical slice를 business capability와 기존 DDD owner에 맞춘다. 요청·Product/Architecture Spec의 동작, 제약, 수용 기준, UC/BR/AC/INV 및 decision ID를 소유 plan에 연결한다. 의존성과 plan 간 handoff를 제안한다.

각 child plan은 소유 업무 규칙의 조건·행위·기대 결과를 설명하는 business-logic unit test 계약만 담는다. Parent plan-set에는 모든 split plan이 구현·개별 검증·통합된 뒤 마지막에 한 번 실행할 feature-level E2E 시나리오, oracle, execution profile, timeout, attempt budget을 제안한다. 단위·회귀 검증은 직접 실행하는 기본 CLI 명령으로 기록하고 완료 gate는 별도 기록한다.

분할 제안과 승인 전제 조건을 session 산출물로 저장한다. 승인이 없으면 `action_required / USER_DECISION_REQUIRED`와 질문 파일을 반환하고, 메인 orchestrator가 제안을 사용자에게 보여준 뒤 실제 답변을 전달한다. 답변이 입력된 재실행에서 승인된 경우에만 canonical 계획 문서를 작성한다.

## Canonical plan 작성

승인 뒤 `worktree.json`에서 받은 `plan_set_id`를 그대로 사용해 각 child plan은 `docs/plans/<plan-set-id>/<plan-id>.md`, index는 `docs/plans/<plan-set-id>/plans.md`에 작성한다. 이 단계에서 `plan_set_id`를 만들거나 바꾸지 않는다. 각 slice의 안정된 `plan_id`는 계속 정하며 tracker Issue 번호와 독립적으로 유지한다.

각 plan에 한국어 구현 목적·범위·수용 기준·의존성·plan handoff·업무 규칙 단위 테스트 계약·필요한 비테스트 검증·실행 위치를 작성한다. [실행 위치 계약](execution-evidence.md#실행-위치) 및 [검증 근거 계약](execution-evidence.md)을 적용한다. Index에는 canonical plan 링크, 요약, 실행 위치, 의존성을 기록한다.

GitHub mode의 Issue 초안과 structured-source는 [GitHub 템플릿](github-issue-template.md)에 맞춰 `<session_directory>/runtime/to-ticket/drafts/`에 저장한다. Parent 초안에 실제 Product/Architecture Spec 경로와 적용 가능한 ticket-scoped SVG 링크를 넣고, diagram이 없으면 이유를 기록한다. 각 child 초안은 하나의 split plan을 표현한다.

Canonical plan과 index, 준비된 초안을 포함하는 `plan_set_draft` artifact를 반환한다. Artifact는 `{kind: "plan_set_draft", base: "workspace", path: "docs/plans/<plan-set-id>/plans.md"}` 형태다. `completed/OK`로 끝내며 Beads와 configured tracker 티켓 발행은 `plan_finalize` stage에서 수행한다.
