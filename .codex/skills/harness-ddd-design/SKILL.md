---
name: harness-ddd-design
description: >
  Harness 메인 워크플로우에서 UC별 후보 DDD 설계를 만드는 L2 step이다.
---

# DDD Design

레벨: L2.

`ddd_architect` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/ddd_architect.md`다.

후보는 `ddd-integration` 전까지 정본이 아니다. 제품 코드와 `ARCHITECTURE.md`를 수정하지 않는다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
