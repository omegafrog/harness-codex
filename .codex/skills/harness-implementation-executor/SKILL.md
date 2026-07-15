---
name: harness-implementation-executor
description: orchestrator가 ready인 ChangeSet active plan의 첫 미완료 작업을 실행할 때 호출한다.
---

# Implementation Executor

레벨: L2.

`implementation_executor` sub-agent를 spawn한다. 정본 지침은
`.codex/agents/references/implementation_executor.md`다.

sub-agent의 reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. 코드, 테스트, plan, review evidence, workflow 산출 문서에는 적용하지 않는다.

메인 에이전트는 첫 미완료 plan task와 쓰기 범위를 전달한다. sub-agent는 다른 작업자의 변경을 되돌리지 않고, 지정된 task 완료에 필요한 파일만 수정한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
