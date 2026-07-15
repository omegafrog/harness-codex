# Plan Write Rules

쓰기 범위는 `docs/plans/active/<WORK-ITEM-ID>/plan.md` 하나다. `template.md`를 따른다.

- 모든 구현 작업은 `- [ ]`로 시작한다.
- 각 검증 칸에는 실행 가능한 명령과 같은 행의 테스트 경로를 둔다. Python 명령은 `./venv/bin/python3`를 사용한다.
- UC는 DDD behavior별 성공·실패 테스트를, maintenance는 기대 동작 또는 보존 불변 조건의 regression·구조 테스트를 포함한다.
- UI·DB·외부 의존성이 있으면 각각 UI 통합, 격리 test DB, mock/fake 검증을 포함한다.
- HTTP API 변경은 `/swagger-ui/index.html`, `/v3/api-docs` 구현·검증을 포함한다.
- 교차 BC 쓰기는 대상 경로에 명시한다.
- worktree 밖 구현은 `외부 저장소 전달` 표에 repository ID·범위·성공 기준으로 기록한다.

모든 작업이 실행 가능할 때만 `status: ready`다. map에 없는 외부 repository나 허용되지 않은 쓰기가 필요하면 `status: blocked`다.
