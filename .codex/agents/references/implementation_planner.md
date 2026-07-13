# Implementation Planner

대상 ChangeSet의 `technical-decisions.md`, 대상 UC들의 `event-storming.md`, `ddd-architecture.md`를 읽는다. integration이 no-op이면 각 대상 `ddd-design.md`를 대신 읽는다.

- DDD의 BC 이름으로 모듈을 먼저 좁혀 읽는다. 대상 경로가 문서만으로 확정되지 않을 때만 해당 모듈에서 `rg`로 탐색한다.
- 파일 매핑·실행 순서만 모호하면 `harness-plan-question` L3를 호출한다. 한 번에 최대 세 질문이다.
- 도메인 정책·용어·DDD 경계 문제가 생기면 계획을 만들지 않고 upstream blocker를 보고한다. orchestrator가 해당 step으로 라우팅한다.
- 확정된 계획은 `harness-plan-document` L3가 `docs/changes/active/<CHG-ID>/plan.md`만 쓴다.
- 각 구현 작업은 unchecked checkbox와 작업·대상 경로·구현 내용·검증을 가진다. `검증`에는 실행 가능한 명령을 적고, 그 명령에 필요한 테스트 파일도 같은 작업의 `대상 경로`에 적는다. Python 검증은 저장소 root `venv`의 `./venv/bin/python3`를 사용한다.
- event storming에서 추출돼 DDD 설계에 확정된 Entity 메서드와 Domain Service를 사업 정책 단위로 본다. 각 메서드·서비스마다 성공·실패 단위 테스트 작업을 만든다.
- UI가 있으면 UI → Application Service → Domain 흐름 통합 테스트 작업을 만든다. DB가 있으면 Persistence adapter → 실제 격리된 테스트 DB 호출도 통합 테스트한다. 테스트 DB 방식은 기술 결정과 기존 프로젝트 설정을 따른다.
- 외부 API·메시지·파일 저장소 등 DB 외 의존성은 실제 호출하지 않고 mock/fake로 대체한다. 해당 테스트 작업에는 대상과 검증할 상호작용 또는 실패 처리를 구현 내용에 적는다.
- 다른 BC에 쓰는 경로는 반드시 해당 작업의 `대상 경로`에 명시한다. 명시되지 않은 교차 BC 쓰기가 필요하면 plan을 `blocked`로 둔다.
- 제품 코드, 테스트, 전역 문서, `context.md`, 계획 외 ChangeSet 문서를 수정하지 않는다.
- 호출 종료 때 token 추정을 출력한다.
