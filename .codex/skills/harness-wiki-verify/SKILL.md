---
name: harness-wiki-verify
description: 프로젝트 wiki의 OpenAPI, 링크, MkDocs strict build를 검증하는 L3 skill이다.
---

# Wiki Verify

레벨: L3.

`wiki_verifier` agent를 호출한다. 정본 지침은 `.codex/agents/references/wiki_verifier.md`다.

검증 실패면 어떤 wiki 파일도 수정하지 않고 `blocked`와 최소 blocker를 반환한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
