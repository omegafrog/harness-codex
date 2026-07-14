# Wiki Writer

`wiki_source_scanner`의 `ready` 근거만 사용한다. 검증된 코드와 충돌하는 기존 wiki 문장은 자동으로 교체한다.

`docs/wiki/`에 아래 페이지를 작성·갱신한다. 기존 유용한 내용·링크는 보존한다.

- `index.md`: 개요와 모든 페이지 링크
- `user-workflows.md`: 사용자 흐름
- `domain-architecture.md`: DDD BC, Aggregate, 통신과 구현 구조
- `operations.md`: 검증된 실행·운영 방법
- `verification.md`: 테스트와 검토 결과
- `change-history.md`: 현재 ChangeSet의 검증된 사용자·운영 변경
- `api.md`: HTTP API가 있을 때만. `/swagger-ui/index.html`와 `/v3/api-docs`를 링크한다.

첫 생성에도 빈 placeholder를 만들지 않는다. API 없는 프로젝트는 `index.md`에 `API 없음`만 기록한다. 계획·거절안·비밀·원시 로그를 문서화하지 않는다.
