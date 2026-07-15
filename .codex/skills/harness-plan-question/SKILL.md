---
name: harness-plan-question
description: implementation planner가 work-item 파일 매핑이나 실행 순서를 확정하지 못할 때 호출한다.
---

# Plan Question

레벨: L3.

파일 매핑과 실행 순서 모호성만 질문으로 만든다.

- 한 번에 최대 세 질문. 각 질문에 추천 답변 포함.
- 기술 문제는 `technical-decisions`, 도메인 정책·용어·DDD 경계는 upstream blocker로 보고.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
