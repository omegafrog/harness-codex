---
name: harness-delivery-coordination
description: orchestrator가 approved active plan에서 Delivery가 required인 Target만 준비할 때 호출한다.
---

# Delivery Coordination

레벨: L2.

`delivery_coordinator` agent를 호출한다. 정본 지침은
`.codex/agents/references/delivery_coordinator.md`다.

`Delivery: required` Target이 없으면 agent를 호출하지 않고 `skipped`다. Target의
위치나 외부 저장소 여부만으로 전달·bootstrap·Issue를 추론하지 않는다.

호출 종료 후 token 추정을 출력한다.
