---
name: harness-wiki-commit
description: 검증된 한국어 wiki 변경만 별도 커밋하는 L3 skill이다.
---

# Wiki Commit

레벨: L3.

`wiki_committer` agent를 호출한다. 정본 지침은 `.codex/agents/references/wiki_committer.md`다.

wiki verify 통과 뒤에만 `docs/wiki/**`, `mkdocs.yml`, `scripts/build-wiki.sh`, `scripts/serve-wiki.sh`를 한국어 commit message로 커밋한다. 기존 stage·ChangeSet 산출물이 있으면 `blocked`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
