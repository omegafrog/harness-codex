---
name: harness-event-storming
description: >
  Harness 메인 워크플로우에서 유스케이스별 이벤트 스토밍을 확정하는 L2 step이다.
---

# Event Storming

레벨: L2.

`oracle` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/oracle.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
