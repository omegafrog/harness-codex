---
name: harness-event-storming-question
description: 확정된 유스케이스 정책의 이벤트 스토밍 모델링 모호성을 질문으로 만드는 L3 skill이다.
---

# Event Storming Question

레벨: L3.

기존 정책의 커맨드·이벤트·정책·시스템·외부 시스템·불변식 매핑 모호성만 질문으로 만든다.

- 한 번에 최대 세 질문. 각 질문에 근거와 추천 답변 포함.
- 새 사업 정책, 액터 목표, 성공·실패 기준, 검증 규칙, 사용자 노출 행위가 필요하면 질문하지 말고 `requirements` 또는 `usecases` blocker를 보고.
- DDD 설계와 기술 전략 질문 금지.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
