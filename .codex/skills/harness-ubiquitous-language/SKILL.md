---
name: harness-ubiquitous-language
description: Harness 메인 워크플로우에서 프로젝트 용어를 확정하는 L2 step이다.
---

# Ubiquitous Language

레벨: L2.

`ubiquitous_language_reviewer` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/ubiquitous_language_reviewer.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
