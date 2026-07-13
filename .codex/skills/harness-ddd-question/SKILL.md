---
name: harness-ddd-question
description: 이벤트 스토밍에 없는 DDD 구조 매핑을 질문으로 만드는 L3 skill이다.
---

# DDD Question

레벨: L3.

속성·타입·Entity/VO·Behavior·Aggregate·BC·통신 방식의 구조 매핑 모호성만 질문으로 만든다.

- 한 번에 최대 세 질문. 각 질문에 event storming 근거와 추천 답변 포함.
- 새 사업 정책, 성공·실패 기준, 검증 규칙, 권한, 상태 전이가 필요하면 질문하지 말고 `requirements`, `usecases`, 또는 `event-storming` blocker를 보고.
- 구현·기술 전략 질문 금지.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
