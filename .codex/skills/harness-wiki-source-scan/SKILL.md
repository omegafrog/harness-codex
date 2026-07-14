---
name: harness-wiki-source-scan
description: review ready ChangeSet의 한국어 wiki 근거를 영향 경로 우선으로 수집하는 L3 skill이다.
---

# Wiki Source Scan

레벨: L3.

`wiki_source_scanner` agent를 호출한다. 정본 지침은 `.codex/agents/references/wiki_source_scanner.md`다.

결과는 호출 맥락에만 반환한다. 파일을 작성·수정하지 않는다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
