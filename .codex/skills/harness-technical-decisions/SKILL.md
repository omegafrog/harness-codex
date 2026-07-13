---
name: harness-technical-decisions
description: >
  Harness 메인 워크플로우에서 기술 문제와 미확정 언어·프레임워크·DB 기반을 확정하는 L2 step이다.
---

# Technical Decisions

레벨: L2.

`technical_decisions` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/technical_decisions.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
