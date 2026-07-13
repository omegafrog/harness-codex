---
name: harness-ddd-application-flow
description: 이벤트 스토밍과 DDD 후보로 Application Service Flow를 갱신하는 L3 skill이다.
---

# DDD Application Service Flow

레벨: L3.

대상 `event-storming.md`와 같은 UC의 `ddd-design.md`만 읽고 Application Service Flow 표와 단일 Mermaid flowchart를 갱신한다.

- Application Service는 호출·조합만 수행한다. 사업 규칙을 넣지 않는다.
- Aggregate 밖 node로 표현하고 root·domain service·port 호출만 연결한다.
- 새 사업 정책은 upstream blocker, 구조 매핑 모호성은 `harness-ddd-question`이 필요한 상태로 반환.
- 별도 Mermaid block·문서 생성 금지.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
