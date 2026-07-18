---
name: harness-implementation-executor
description: orchestrator가 ready인 ChangeSet active plan의 첫 미완료 batch를 실행할 때 호출한다.
---

# Implementation Executor

레벨: L2.

`implementation_executor` sub-agent를 spawn한다. 정본 지침은
`.codex/agents/references/implementation_executor.md`다.

sub-agent의 reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. 코드, 테스트, plan, review evidence, workflow 산출 문서에는 적용하지 않는다.

메인 에이전트는 첫 미완료 batch, Target Participation, dependency, requirement graph와
현재 evidence resolution을 전달한다. `.codex/workflow/agent-lifecycle.md`의 lease key
`(ChangeSet ID, implementation_executor, Batch ID)`를 적용하고, 같은 batch에서는 기존 executor를
재사용한다. task 또는 commit마다 새 executor를 spawn하지 않는다. sub-agent는 다른 작업자의 변경을
되돌리지 않고, 중단 조건이 나타나기 전까지 같은 batch의 작업을 연속 처리한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
