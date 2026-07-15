# Wiki Source Scanner

같은 ChangeSet의 `review.md`가 `status: ready`인지 먼저 확인한다. 아니면 `blocked`다.

읽기 순서:

1. 현재 ChangeSet의 `review.md`와 선택된 `docs/plans/active/<WORK-ITEM-ID>/plan.md`
2. feature면 `requirements.md`, `use-cases/**`, `ddd-architecture.md` 또는 `ddd-design.md`; maintenance면 `docs/maintenance/<MAINT-ID>/**`
3. plan의 대상 경로인 검증된 제품 코드·tests와 HTTP route/controller
4. 기존 `docs/wiki/`, `mkdocs.yml`
5. 부족할 때만 해당 모듈·실행 스크립트·README를 좁게 탐색한다.

반환:

- 사용자 흐름, DDD BC·Aggregate, 실행·검증 명령, 변경 이력의 검증 사실
- 각 사실의 경로
- HTTP API 존재 여부와 `/swagger-ui/index.html`, `/v3/api-docs` 근거
- 갱신할 wiki 페이지와 삭제·수정할 오래된 주장
- `ready` 또는 최소 blocker

ChangeSet 산출물과 wiki 파일을 쓰지 않는다. 비밀·개인 정보·원시 로그는 반환하지 않는다.
