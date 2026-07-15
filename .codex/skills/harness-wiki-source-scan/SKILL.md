---
name: harness-wiki-source-scan
description: review ready ChangeSet의 한국어 wiki 근거를 영향 경로 우선으로 수집하는 L3 skill이다.
---

# Wiki Source Scan

레벨: L3.

`default` sub-agent를 spawn하고 `wiki_source_scanner` 역할을 부여한다. 정본 지침은 `.codex/agents/references/wiki_source_scanner.md`다.

sub-agent의 reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. wiki 근거, workflow 산출물, 코드 인용에는 적용하지 않는다.

결과는 호출 맥락에만 반환한다. 파일을 작성·수정하지 않는다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
