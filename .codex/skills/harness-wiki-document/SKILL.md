---
name: harness-wiki-document
description: 검증된 wiki 근거로 프로젝트 전체 한국어 wiki 페이지를 작성·갱신하는 L3 skill이다.
---

# Wiki Document

레벨: L3.

`wiki_writer` sub-agent를 spawn한다. 정본 지침은 `.codex/agents/references/wiki_writer.md`다.

sub-agent의 reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. `docs/wiki/` 산출 문서에는 적용하지 않고, 한국어 문서 품질과 템플릿 구조를 유지한다.

`docs/wiki/`만 작성·갱신한다. 첫 생성이면 `개요`, `사용자 흐름`, `도메인·아키텍처`, `운영`, `검증`, `변경 이력` 페이지를 만들고, HTTP API가 있으면 `API` 페이지도 만든다. 기존 페이지는 검증된 코드 기준으로 갱신한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
