---
name: harness-wiki-mkdocs
description: 한국어 project wiki의 MkDocs 설정과 실행 스크립트를 생성·갱신하는 L3 skill이다.
---

# Wiki MkDocs

레벨: L3.

`wiki_mkdocs_manager` agent를 호출한다. 정본 지침은 `.codex/agents/references/wiki_mkdocs_manager.md`다.

`mkdocs.yml`, `docs/wiki/requirements.txt`, `scripts/build-wiki.sh`, `scripts/serve-wiki.sh`만 작성·갱신한다. `.codex/skills/harness-project-wiki/assets/`를 baseline으로 사용한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
