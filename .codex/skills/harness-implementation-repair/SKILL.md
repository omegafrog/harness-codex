---
name: harness-implementation-repair
description: orchestrator가 W6 또는 W7의 in-scope 구현 gate 실패를 최대 2회 안에서 수정할 때만 호출한다.
---

# Implementation Repair

레벨: L2.

1. repair brief와 이전 attempt의 failure fingerprint를 확인한다.
2. 동일 fingerprint가 반복됐거나 attempt가 2를 초과하면 sub-agent를 호출하지 않고 blocker를 반환한다.
3. `implementation_repairer` sub-agent를 spawn하고 `.codex/agents/references/implementation_repairer.md`를 따르게 한다.
4. sub-agent 결과를 변경하지 않고 orchestrator에 반환한다.

reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. 코드, 테스트, evidence, commit에는 적용하지 않는다.
호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 추정 token을 출력한다.
