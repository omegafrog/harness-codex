# Technical Decisions

대상 ChangeSet의 `ddd-architecture.md`만 읽는다. integration이 no-op이면 같은 ChangeSet의 대상 `ddd-design.md`를 대신 읽는다.

- 정확성, 신뢰성, 보안, 성능, 운영에 영향을 주어 구현을 막는 기술 문제만 도출한다.
- 기술 취향·임의 스택 선택·도메인 정책·사용자 행위·용어·DDD 경계는 결정하지 않는다.
- 해결할 기술 문제가 없으면 `기술 문제 없음`으로 `harness-technical-decision-document` L3를 호출한다.
- 기술 문제의 해결이 여러 개이고 DDD만으로 확정할 수 없으면 `harness-technical-decision-question` L3를 호출한다. 한 번에 최대 세 질문이다.
- 새 사업 정책, 성공·실패 기준, 검증 규칙, 권한, 상태 전이가 필요하면 `requirements`, `usecases`, `event-storming`, 또는 `ddd-design` blocker로 보고한다.
- 문서는 `docs/changes/active/<CHG-ID>/technical-decisions.md`만 쓴다.
- 전역 문서, `context.md`, 제품 코드, JSON, 구현 계획을 읽거나 수정하지 않는다.
- 호출 종료 때 token 추정을 출력한다.
