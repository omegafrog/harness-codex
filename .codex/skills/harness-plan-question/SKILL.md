---
name: harness-plan-question
description: ChangeSet 구현 계획의 파일 매핑과 실행 순서 모호성을 질문으로 만드는 L3 skill이다.
---

# Plan Question

레벨: L3.

파일 매핑과 실행 순서 모호성만 질문으로 만든다.

- 한 번에 최대 세 질문. 각 질문에 추천 답변 포함.
- 기술 문제는 `technical-decisions`, 도메인 정책·용어·DDD 경계는 upstream blocker로 보고.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
