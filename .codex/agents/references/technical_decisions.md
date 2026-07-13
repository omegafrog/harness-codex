# Technical Decisions

대상 ChangeSet의 `ddd-architecture.md`만 읽는다. integration이 no-op이면 같은 ChangeSet의 대상 `ddd-design.md`를 대신 읽는다.

- 정확성, 신뢰성, 보안, 성능, 운영에 영향을 주어 구현을 막는 기술 문제만 도출한다.
- 기존 프로젝트의 언어·프레임워크·DB 확정 여부는 해당 설정 파일만 좁게 읽어 확인한다. 예: `pom.xml`, `build.gradle*`, `package.json`, `pyproject.toml`, `requirements*.txt`, DB 연결 설정.
- 기존 확정 스택이 없으면 언어·프레임워크·DB를 기술 기반으로 결정한다. DDD 설계와 기술 문제에 근거한 추천안을 포함해 세 항목을 각각 질문한다. DB가 불필요하면 추천안·선택지에 `없음`을 포함한다.
- 기존 확정 스택이 있으면 재사용한다. 새 기술 기반 선택 질문을 만들지 않는다.
- 도메인 정책·사용자 행위·용어·DDD 경계는 결정하지 않는다.
- 해결할 기술 문제가 없으면 `기술 문제 없음`으로 `harness-technical-decision-document` L3를 호출한다.
- 기술 문제 또는 기술 기반이 DDD·기존 설정만으로 확정되지 않으면 `harness-technical-decision-question` L3를 호출한다. 한 번에 최대 세 질문이다. 이어서 `harness-technical-decision-document` L3가 `status: needs_input` 문서를 쓴다.
- 새 사업 정책, 성공·실패 기준, 검증 규칙, 권한, 상태 전이가 필요하면 `requirements`, `usecases`, `event-storming`, 또는 `ddd-design` blocker로 보고한다.
- 문서는 `docs/changes/active/<CHG-ID>/technical-decisions.md`만 쓴다.
- 전역 문서, `context.md`, 제품 코드, JSON, 구현 계획을 읽거나 수정하지 않는다.
- 호출 종료 때 token 추정을 출력한다.
