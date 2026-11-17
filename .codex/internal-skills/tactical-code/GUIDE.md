---
model_tier: implementation
---
# tactical-code

## 목적

완료된 tactical design과 선행 결정에 근거해 application code와 요구에 필요한 테스트를 구현한다. 이 stage는 승인된 split plan이 아닌, 사용자가 직접 요청한 feature scope를 따른다.

## 입력과 경계

요청, `CONTEXT.md`, 완료된 tactical design, technology, API와 data 결과, frontend-design handoff가 제공된 경우 해당 결과를 읽는다. workflow 시작 시점과 현재 `HEAD`, branch, dirty status를 확인하고 사용자의 기존 변경을 보존한다. `harness-workspace-preflight.mjs --for-implementation`을 통과하지 않으면 수정하지 않는다.

기존 모델·public API·규칙 소유자를 재사용하고 전술 설계가 정한 순서대로 작은 변경을 한다. 문서상 미정인 UI/API/storage/보안·권한·업무 규칙을 추론하지 않는다. 필요한 결정이 빠졌으면 영향을 받은 경로와 unblock 조건을 적어 `blocked/DEPENDENCY_INCOMPLETE`로 반환한다. 요청된 비즈니스 동작을 검증하는 테스트를 추가하고 프로젝트 기본 CLI로 실행한다. 기존 테스트 실패는 기준선과 구분한다.

새 UI 구현은 별도 `frontend-design` workflow가 소유한다. handoff가 없는 UI는 만들지 않는다. Spec 또는 plan을 찾거나 작성해 입력으로 삼지 않는다. tracker, PR, `docs/contracts/`와 E2E 인프라를 호출하지 않는다.

## 종료

코드와 테스트 변경을 정확한 `commit_request: {message, paths}`로 반환한다. `git add`와 `git commit`은 하지 않는다. `git status --short`, 실행한 명령과 결과, 생략한 검증을 보고한다. 성공은 `action_required/REVIEW_REQUIRED`가 아니라 이 flow에 선언한 완료 조건으로 보고하며, 구현·테스트가 모두 통과한 경우만 `completed/OK`다. 남은 질문·외부 환경·결정 blocker는 성공으로 표시하지 않는다.
