---
model_tier: implementation
---
# tactical-code

## 목적

게시된 plan set의 ticket 하나(`context.plan_id`)를 완료된 tactical design과 선행 결정에 근거해 코드와 그 ticket의 테스트로 구현한다. 한 실행은 ticket 한 개이고 `commit_request`도 한 개다. 다음 ticket은 orchestrator가 `harness-context.mjs`의 `ready_tickets`에서 골라 새 실행으로 시작한다.

## 입력과 경계

먼저 ticket 파일 `docs/plans/<plan-set-id>/<plan_id>.md`(`input_refs`의 kind `ticket`)를 끝까지 읽는다. ticket이 구현할 규칙(INV/EX/AC)과 강제 위치, 검증 테스트, 접하는 컨텍스트와 경계 규칙, 의존한 결정, 선행 ticket, 완료 기준을 정한다. 그다음 ticket이 인용한 근거만 읽는다: `docs/specs/<plan-set-id>/tactical-design.md`에서 ticket이 가리킨 모델·Aggregate·Application Service 메서드·인터페이스·메서드별 통합·경계 행, `docs/implementation/<plan-set-id>/`의 인용된 `technology.md`·`api.md`·`data.md`, UI design artifact, `CONTEXT.md`의 용어. 설계 전체나 다른 ticket 문서를 한꺼번에 읽지 않는다. 선행 ticket이 만든 코드는 저장소의 현재 코드로 읽는다.

workflow 시작 시점과 현재 `HEAD`, branch, dirty status를 확인하고 사용자의 기존 변경을 보존한다. `harness-workspace-preflight.mjs --for-implementation`을 통과하지 않으면 수정하지 않는다. 편집 전에 ticket을 `in-progress`로 바꾼다: `node .codex/scripts/harness-tracker.mjs sync --root <workspace_root> --ticket <ref> --status in-progress`. `<ref>`는 local-markdown이면 ticket 경로, GitHub mode이면 `harness-context.mjs`의 `plan_tickets`에 있는 이 ticket의 값이다.

## 구현

- 코드 변경 전 [Ponytail 구현 원칙](../implement/references/ponytail.md)을 읽는다.
- 기존 모델·public API·규칙 소유자를 재사용하고 ticket이 정한 순서로 작은 변경을 한다: ticket의 강제 위치(Value Object·Aggregate Root 메서드·Domain Service)에 규칙을 구현하고, Application Service가 호출 순서와 transaction 경계를 지키며, `api.md`가 정한 entry와 `data.md`가 정한 저장을 연결한다. ticket이 인용한 outbound 인터페이스는 정해진 위치에 시그니처와 실패 계약을 지키는 구현체를 두고, 조립 위치에서 Application Service에 연결한다. 계약의 데이터 매핑과 공유 트랜잭션을 적용하고, 재사용으로 확정한 구현·조립은 같은 계약을 따른다. 한 규칙을 여러 계층에 복제하지 않는다.
- 이 ticket의 컨텍스트만 바꾼다. 다른 컨텍스트는 ticket의 `컨텍스트 경계`가 허용한 공개 API·port로만 접하고, 다른 컨텍스트의 table·Repository에 접근하거나 내부 타입을 넘기지 않는다. 전술 설계의 경계 강제 검사를 ticket이 정한 방식으로 구현한다.
- 문서상 미정인 UI/API/storage/보안·권한·업무 규칙을 추론하지 않는다. 필요한 결정이 빠졌으면 영향을 받은 ticket·stage와 unblock 조건을 적어 ticket을 `blocked`로 바꾸고 `blocked/DEPENDENCY_INCOMPLETE`로 반환한다. 선행 ticket의 공개 API가 ticket의 전제와 다르면 같은 방식으로 반환하며 선행 ticket을 고치지 않는다.
- ticket의 `소유 규칙과 검증` 표가 정한 테스트(파일과 테스트 이름)를 이 ticket에서 작성하고, 조건·행위·기대 결과로 업무 규칙을 검증한다. 경계 검사 테스트도 함께 만든다. 프로젝트 기본 CLI로 이 ticket의 테스트와 기존 테스트를 실행한다. 기존 테스트 실패는 기준선과 구분한다.
- 새 UI 구현은 별도 `frontend-design` workflow가 소유한다. `frontend: true` ticket은 해당 ticket의 `frontend-implementation`과 `frontend-visual-review` 완료 뒤 시작하며, 그 결과 변경과 이 ticket의 나머지 코드를 함께 commit한다. design·ticket 문서를 새로 쓰거나 고치지 않는다. tracker 발행, PR, `docs/contracts/`와 E2E 인프라를 호출하지 않는다.

## 종료

테스트와 `필요한 비테스트 검증`이 통과한 뒤에만 ticket을 `completed`로 바꾼다(`harness-tracker.mjs sync ... --status completed`). local-markdown mode는 이 명령이 ticket 파일의 `status`를 바꾸므로 그 파일을 commit 경로에 포함한다. GitHub mode는 외부 상태만 바뀐다.

코드·테스트 변경을 정확한 `commit_request: {message, paths}`로 반환한다. message는 `tactical-code: <plan-set-id>/<plan-id>`로 시작하고 한 ticket의 변경만 담는다. `git add`와 `git commit`은 하지 않는다. `git status --short`, 실행한 명령과 결과, 생략한 검증을 보고한다. 성공은 `action_required/REVIEW_REQUIRED`가 아니라 `completed/OK`이며 ticket의 완료 기준과 모든 테스트가 통과한 경우만이다. 남은 질문·외부 환경·결정 blocker는 성공으로 표시하지 않는다.
