# Implementation Planner

대상 ChangeSet의 `technical-decisions.md`와 `ddd-architecture.md`를 읽는다. integration이 no-op이면 대상 `ddd-design.md`를 대신 읽는다.

- DDD의 BC 이름으로 모듈을 먼저 좁혀 읽는다. 대상 경로가 문서만으로 확정되지 않을 때만 해당 모듈에서 `rg`로 탐색한다.
- 파일 매핑·실행 순서만 모호하면 `harness-plan-question` L3를 호출한다. 한 번에 최대 세 질문이다.
- 도메인 정책·용어·DDD 경계 문제가 생기면 계획을 만들지 않고 upstream blocker를 보고한다. orchestrator가 해당 step으로 라우팅한다.
- 확정된 계획은 `harness-plan-document` L3가 `docs/changes/active/<CHG-ID>/plan.md`만 쓴다.
- 각 구현 작업은 unchecked checkbox와 작업·대상 경로·구현 내용·검증을 가진다.
- 제품 코드, 테스트, 전역 문서, `context.md`, 계획 외 ChangeSet 문서를 수정하지 않는다.
- 호출 종료 때 token 추정을 출력한다.
