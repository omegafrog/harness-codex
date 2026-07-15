---
name: harness-code-planner
description: orchestrator가 ready인 UC 또는 maintenance work item의 active plan을 만들 때 호출한다.
---

# Plan

레벨: L2.

`implementation_planner` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/implementation_planner.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
