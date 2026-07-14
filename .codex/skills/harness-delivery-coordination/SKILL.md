---
name: harness-delivery-coordination
description: Harness 메인 워크플로우에서 plan 뒤 다중 저장소 전달 범위를 검사하고 준비된 저장소에 GitHub Issue를 연결하는 L2 step이다.
---

# Delivery Coordination

레벨: L2.

`delivery_coordinator` agent를 호출한다. 정본 지침은
`.codex/agents/references/delivery_coordinator.md`다.

- `plan.md`의 `외부 저장소 전달`만 처리한다.
- agent는 `harness-delivery-repository-check` L3로 대상 저장소의 Harness 준비 상태를 먼저 검사한다.
- 미초기화 저장소는 `harness-delivery-bootstrap` L3로 초기화한 뒤 재검사한다.
- 준비된 모든 저장소에 `harness-delivery-issue` L3로 GitHub 구현 Issue를 생성·재사용한다.
- 호출 종료 후 token 추정을 출력한다.
