---
name: harness-review
description: orchestrator가 모든 plan 작업이 완료된 work item의 구현 gate를 검토할 때 호출한다.
---

# Review

레벨: L2.

`reviewer` agent를 호출한다. 정본 지침은 `.codex/agents/references/reviewer.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
