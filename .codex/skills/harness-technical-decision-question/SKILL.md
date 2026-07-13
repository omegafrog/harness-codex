---
name: harness-technical-decision-question
description: 구현을 막는 기술 문제 또는 미확정 언어·프레임워크·DB 기반의 선택지를 질문으로 만드는 L3 skill이다.
---

# Technical Decision Question

레벨: L3.

기술 문제 해결 또는 미확정 기술 기반만 질문으로 만든다.

- 한 번에 최대 세 질문. 각 질문에 기술 문제와 추천 답변 포함.
- 기존 프로젝트에 확정 스택이 없을 때만 언어·프레임워크·DB 질문을 각각 만든다. DDD 설계와 기술 문제 기반 추천 답변을 포함한다. DB가 불필요하면 `없음`을 선택지에 포함한다.
- 기존 확정 스택이 있으면 언어·프레임워크·DB 질문 금지.
- 사업 정책, 사용자 행위, 도메인 규칙, 용어, DDD 경계가 필요하면 질문하지 말고 upstream blocker를 보고.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
