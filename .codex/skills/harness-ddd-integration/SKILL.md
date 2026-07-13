---
name: harness-ddd-integration
description: >
  Harness 메인 워크플로우에서 다중 UC 후보 DDD 설계를 ChangeSet DDD architecture로 통합하는 L2 step이다.
---

# DDD Integration

레벨: L2.

`ddd_design_integrator` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/ddd_design_integrator.md`다.

대상 UC가 하나면 문서 없이 no-op으로 통과한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
