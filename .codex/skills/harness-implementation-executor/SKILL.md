---
name: harness-implementation-executor
description: orchestrator가 ready인 active work-item plan의 첫 미완료 작업을 실행할 때 호출한다.
---

# Implementation Executor

레벨: L2.

`implementation_executor` agent를 호출한다. 정본 지침은
`.codex/agents/references/implementation_executor.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
