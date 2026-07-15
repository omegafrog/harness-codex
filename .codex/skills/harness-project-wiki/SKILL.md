---
name: harness-project-wiki
description: orchestrator가 review ready와 wiki 영향을 확인한 뒤 프로젝트 wiki를 갱신할 때 호출한다.
---

# Wiki

레벨: L2.

`review.md`가 `status: ready`이고 wiki 영향이 있을 때만 다음 L3를 순서대로 호출한다.

1. `harness-wiki-source-scan`: 현재 ChangeSet 산출물과 영향 경로를 먼저 읽어 wiki 근거를 반환한다. 부족할 때만 코드베이스 범위를 넓힌다.
2. `harness-wiki-document`: 반환 근거로 프로젝트 전체 wiki 페이지를 작성·갱신한다.
3. `harness-wiki-mkdocs`: MkDocs 설정·스크립트를 생성·갱신한다.
4. `harness-wiki-install`: root `venv`에 wiki 의존성을 설치한다.
5. `harness-wiki-verify`: OpenAPI·링크·strict build gate를 확인한다.
6. `harness-wiki-commit`: gate 통과 wiki 변경만 한국어 커밋한다.

HTTP API가 있으면 `/swagger-ui/index.html`과 `/v3/api-docs`가 모두 있어야 한다. 없으면 `blocked`로 종료한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
