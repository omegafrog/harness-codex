---
name: harness-code-planner
description: Harness 메인 워크플로우에서 ChangeSet 구현 계획을 만드는 L2 step이다.
---

# Plan

레벨: L2.

`implementation_planner` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/implementation_planner.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
