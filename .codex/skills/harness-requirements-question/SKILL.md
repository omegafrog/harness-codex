---
name: harness-requirements-question
description: requirements_interviewer가 요구사항의 미확정 사용자 결정을 근거·선택지·추천안이 있는 단일 질문으로 해소할 때 호출하는 L3 skill이다.
---

# Requirements Question

레벨: L3.

미확정 요구사항 결정을 한 번에 하나씩 해소한다.

- 읽는다: 질문을 만들기 전에 `references/interview-protocol.md`를 읽고 따른다.
- 조사한다: 저장소와 기존 문서에서 확인할 수 있는 사실은 사용자에게 묻지 않는다.
- 선택한다: 의존성이 가장 크거나 요구사항 결과를 가장 크게 바꾸는 사용자 결정 하나를 고른다.
- 질문한다: 근거, 구체적 선택지, 추천 답변과 추천 이유를 포함한 질문 하나만 제시한다.
- 반복한다: 모호한 답은 같은 질문 ID로 구체화하고, 해소되면 다음 미확정 결정으로 이동한다.
- 중단한다: 질문을 제시한 turn에는 문서 작성이나 다음 workflow step을 수행하지 않는다.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
