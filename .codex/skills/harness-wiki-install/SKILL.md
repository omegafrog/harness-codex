---
name: harness-wiki-install
description: root venv에 선언된 MkDocs wiki 의존성을 설치하는 L3 skill이다.
---

# Wiki Install

레벨: L3.

`wiki_installer` agent를 호출한다. 정본 지침은 `.codex/agents/references/wiki_installer.md`다.

root `venv`에만 `docs/wiki/requirements.txt`를 설치한다. 저장소 파일을 수정하지 않는다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
