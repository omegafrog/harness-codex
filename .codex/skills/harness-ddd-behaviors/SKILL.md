---
name: harness-ddd-behaviors
description: 이벤트 스토밍과 DDD 후보의 Entity/VO로 behavior를 갱신하는 L3 skill이다.
---

# DDD Behaviors

레벨: L3.

대상 `event-storming.md`와 같은 UC의 `ddd-design.md`만 읽고 Behaviors 표와 단일 Mermaid flowchart를 갱신한다.

- 한 모델 안의 상태 변경·검증은 Entity/VO method, 여러 Aggregate를 걸치는 정책은 Domain Service로 둔다.
- 새 사업 정책은 upstream blocker, 구조 매핑 모호성은 `harness-ddd-question`이 필요한 상태로 반환.
- 별도 Mermaid block·문서 생성 금지.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
