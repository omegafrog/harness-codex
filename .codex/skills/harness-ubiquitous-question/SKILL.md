---
name: harness-ubiquitous-question
description: 프로젝트 ubiquitous language의 미해결 용어를 사용자 질문으로 만드는 L3 skill이다.
---

# Ubiquitous Question

레벨: L3.

미해결 프로젝트 용어만 질문으로 만든다.

- 한 번에 최대 세 질문.
- 각 질문에 근거와 추천 답변 포함.
- 요구사항 정책, 구현, Aggregate, Event, 상태 전이 질문 금지.
- 충분한 답을 얻을 때까지 ubiquitous language agent가 반복 호출할 수 있다.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
