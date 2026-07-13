---
name: harness-ddd-bounded-contexts
description: 이벤트 스토밍과 DDD 후보로 BC와 BC 간 통신을 확정하는 L3 skill이다.
---

# DDD Bounded Contexts

레벨: L3.

대상 `event-storming.md`와 같은 UC의 `ddd-design.md`만 읽고 BC 통신 표와 단일 Mermaid flowchart를 갱신한다.

- 통신 방식은 `internal_http`, `domain_event`, `shared_database` 중 하나.
- 다른 BC 내부 모델 직접 호출 금지.
- 이 substep이 끝나면 모든 섹션과 Mermaid가 완성됐을 때만 `status: ready`.
- 새 사업 정책은 upstream blocker, 구조 매핑 모호성은 `harness-ddd-question`이 필요한 상태로 반환.
- 별도 Mermaid block·문서 생성 금지.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
