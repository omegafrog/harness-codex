---
name: harness-technical-decision-question
description: 구현을 막는 기술 문제의 해결 선택지를 질문으로 만드는 L3 skill이다.
---

# Technical Decision Question

레벨: L3.

기술 문제의 해결 방식만 질문으로 만든다.

- 한 번에 최대 세 질문. 각 질문에 기술 문제와 추천 답변 포함.
- 기술 취향·임의 스택 선택 질문 금지.
- 사업 정책, 사용자 행위, 도메인 규칙, 용어, DDD 경계가 필요하면 질문하지 말고 upstream blocker를 보고.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
