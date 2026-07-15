---
name: harness-technical-decisions
description: orchestrator가 선택된 UC 또는 maintenance work item의 구현 차단 기술 결정을 확정할 때 호출한다.
---

# Technical Decisions

레벨: L2.

`technical_decisions` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/technical_decisions.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
