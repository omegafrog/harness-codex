---
name: harness-plan-document
description: 확정된 ChangeSet 구현 계획을 체크박스 문서로 작성하는 L3 skill이다.
---

# Plan Document

레벨: L3.

확정 구현 계획과 호출자가 준 status만 사용해
`docs/changes/active/<CHG-ID>/plan.md`만 작성하거나 갱신한다.

- `.codex/skills/harness-plan-document/references/template.md`를 따른다.
- 모든 구현 작업은 `- [ ]`로 시작한다. implementation agent가 나중에 검증 통과 작업만 `- [x]`로 갱신한다.
- 각 `검증` 칸에는 실행 가능한 명령을 적고, 필요한 테스트 경로는 같은 행 `대상 경로`에 포함한다. Python 검증 명령은 `./venv/bin/python3`를 사용한다.
- DDD 설계의 Entity 메서드·Domain Service별 성공·실패 단위 테스트, UI가 있으면 UI 포함 통합 테스트, DB가 있으면 실제 격리 테스트 DB 통합 테스트, DB 외 의존성 mock/fake 테스트가 각각 계획에 있어야만 `status: ready`를 사용한다.
- HTTP API를 구현·변경하면 OpenAPI 런타임 endpoint `/swagger-ui/index.html`, `/v3/api-docs`의 구현·검증 작업이 있어야만 `status: ready`를 사용한다.
- 교차 BC 쓰기가 있으면 그 경로를 해당 작업의 `대상 경로`에 함께 적는다.
- 현재 worktree 밖 구현은 체크박스에 넣지 않고 `외부 저장소 전달` 표에 repository ID·범위·성공 기준으로만 기록한다. map에 없는 repository는 `blocked`다.
- 도메인 정책, 기술 결정, DDD 설계, 제품 코드를 변경하지 않는다.
- 모든 작업이 실행 가능할 때만 `status: ready`.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
