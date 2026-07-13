---
name: harness-ddd-integration-question
description: 다중 UC 후보 DDD의 기존 정책 범위 충돌을 질문으로 만드는 L3 skill이다.
---

# DDD Integration Question

레벨: L3.

같은 모델의 중복, Aggregate 소유자, BC 경계, BC 간 통신 매핑 충돌만 질문으로 만든다.

- 한 번에 최대 세 질문. 각 질문에 충돌한 후보와 추천 답변 포함.
- 새 사업 정책이 필요하면 질문하지 말고 가장 가까운 upstream blocker를 보고.
- 구현·기술 전략 질문 금지.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
