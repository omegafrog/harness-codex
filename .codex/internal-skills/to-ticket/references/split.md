# Plan split

`to-ticket`의 initial phase가 승인된 Product/Architecture Spec을 vertical plan으로 분할하고 review 입력을 만든다.

## 입력과 분석

1. `context.worktree_ref`가 가리키는 정본 `worktree.json`에서 `workspace`, `session_directory`, `branch`, `head`, `return_root`, `plan_set_id`를 읽는다. `plan_set_id`가 없으면 중단한다. Tracker ticket ID와 같을 필요는 없다. `workspace`를 작업 위치로 사용한다. 진입 시 `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --defer-tracker-sync --json`을 실행해 `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다.
2. 요청 원문, Product/Architecture Spec, 현행 `docs/contracts/`와 연결 다이어그램, 관련 System Target·accepted Architecture Decision을 읽는다. 전달된 Spec 경로를 우선하고, 별도 지정이 없으면 `docs/specs/<plan-set-id>/request.md`, `docs/specs/<plan-set-id>/product-spec.md`, `docs/specs/<plan-set-id>/architecture-spec.md`를 읽는다. split 경계·기존 owner·실행 전제를 Spec에서 판별할 수 있는 만큼 현재 코드 조사가 필요하면 `code-research`를 실행한다.
3. 활성 workspace의 `<workspace_root>/.codex/context-budget.json`에서 `max_plan_tokens`를 읽는다. 로딩·구현·업무 규칙 단위 테스트·수정 근거를 포함해 각 plan 예상 토큰과 산정 근거를 기록하고, 각 plan이 한도 안에 들도록 나눈다. Architecture Spec에 material technology choice가 있으면 `system-targets.yaml`의 `decision_metadata.decision_layer_version: 2`과 Architecture Decision ID, 승인 `decision_evidence_complete` 및 `decision_review_complete` 결과를 확인한다.

## 계획 분할

각 vertical slice를 업무 기능과 승인된 DDD owner에 맞춘다. 각 plan에 `계층 배치` 절을 두고 Architecture Spec에 따라 이 plan의 코드가 어느 계층에 가는지 적는다: domain(Entity·Value Object·Aggregate 메서드와 불변식), service(application 흐름·트랜잭션), api(HTTP 입출력·DTO 검증·세션·HTTP 오류 변환), db(repository 구현·migration). 구현자와 리뷰어가 같은 배치를 기준으로 삼는다. 소유 Aggregate의 Root·Entity·Value Object·도메인 메서드·불변 조건과 application service 조합을 보존한다. 요청·Product/Architecture Spec의 동작, 제약, 수용 기준, UC/BR/AC/INV 및 decision ID를 소유 plan에 연결한다. 의존성과 plan 간 handoff를 제안한다.

각 기능 child plan은 소유 업무 규칙의 조건·행위·기대 결과를 설명하는 business-logic unit test 계약만 담는다. 마지막 child로 `e2e` plan을 하나 둔다. 이 plan은 모든 기능 plan에 의존하고, Product Spec 13절 시나리오를 Architecture Spec 12.7 환경에서 실행하는 E2E 테스트 코드와 `execution.json` profile(`purpose: "e2e"`), `docs/agents/EXEC.md` 실행 안내를 만든다. 시나리오와 환경은 Spec을 참조하고 plan에서 새로 정하지 않는다. Parent는 이 plan을 참조한다. 단위·회귀 검증은 직접 실행하는 기본 CLI 명령으로 기록하고 완료 gate는 별도 기록한다.

분할 결과를 바탕으로 canonical 계획 문서를 작성하고 독립 리뷰를 요청한다. 승인된 Spec만으로 필수 결정을 내릴 수 없을 때는 그 결정만 사용자에게 묻는다. 티켓 발행 승인은 전체 계획과 독립 리뷰가 끝난 뒤 orchestrator가 요청한다.

## Canonical plan 작성

`worktree.json`에서 받은 `plan_set_id`를 그대로 사용해 각 child plan은 `docs/plans/<plan-set-id>/<plan-id>.md`, index는 `docs/plans/<plan-set-id>/plans.md`에 작성한다. 이 단계에서 `plan_set_id`를 만들거나 바꾸지 않는다. 각 slice의 안정된 `plan_id`는 계속 정하며 tracker Issue 번호와 독립적으로 유지한다.

기능 plan의 `필요한 비테스트 검증`에는 그 plan의 작업 환경에서 바로 실행할 수 있는 것만 적는다(빌드, `./mvnw test` 같은 기본 CLI, 정적 확인). 실제 DB·외부 서비스·보안 체인이 있어야 하는 확인은 쓰지 않고 마지막 `e2e` plan의 시나리오로 확인한다. 각 plan에 한국어 구현 목적·범위·수용 기준·의존성·plan handoff·업무 규칙 단위 테스트 계약·필요한 비테스트 검증을 작성한다. 실행 위치·브랜치는 agent가 작성하지 않고 정적 실행기가 생성한다. [실행 위치 계약](execution-evidence.md#실행-위치) 및 [검증 근거 계약](execution-evidence.md)을 적용한다. Index에는 canonical plan 링크, 요약, 의존성을 기록한다.

GitHub mode의 Issue 초안과 structured-source는 [GitHub 템플릿](github-issue-template.md)에 맞춰 `<session_directory>/runtime/to-ticket/drafts/`에 저장한다. Parent 초안에 실제 Product/Architecture Spec 경로와 적용 가능한 ticket-scoped SVG 링크를 넣고, diagram이 없으면 이유를 기록한다. 각 child 초안은 하나의 split plan을 표현한다.

Canonical plan과 index, 준비된 초안을 포함하는 `plan_set_draft` artifact를 반환한다. Artifact는 `{kind: "plan_set_draft", base: "workspace", path: "docs/plans/<plan-set-id>/plans.md"}` 형태다. Canonical plans 작성 뒤 같은 `to-ticket` execution이 독립 fresh reviewer를 호출하고 plan-review gate를 통과한다. Beads와 configured tracker 티켓 발행은 후속 `tracker-publish` workflow stage에서 수행한다.
