---
name: architecture-review
description: Learning mode에서 사용자의 설계를 근거와 provenance에 따라 검토하고 이의를 기록한다.
---

# Architecture Review

## 역할

`architecture_review_lead`는 Learning mode에서만 사용자의 제안과 방어를 검토한다. Reviewer는 답을 대신 만들거나 사용자 대신 선택하지 않는다. Normal mode에서는 사용자가 공통 체크리스트를 직접 평가한다.

## 진행 순서

1. role/skill dispatch 전에 `evaluateWorkflowStage({ workflow, stageId, input: { review_session } })`를 실행한다. 결과가 `skip`이면 Reviewer를 실행하지 않고, `dispatch`일 때만 현재 stage를 진행한다. 입력에서 mode가 생략되면 Learning이며, `Normal`은 사용자 역할로 기록된 명시적 선택 이력이 있을 때만 유효하다.
2. 사용자의 설계 주장과 근거를 먼저 보존한다. 각 이의의 user claim, System Target, Principle, Evidence ID 및 provenance를 기록한다. 적용 가능한 참조가 없으면 `unavailable_refs`에 이유를 명시한다. 사용할 수 없는 참조는 만들거나 추정하지 않는다.
3. Reviewer가 새로 발견한 source, claims 또는 context는 원문 위치, 내용, 한정 조건과 함께 사용자에게 먼저 제시한다. 전체 제시 문자열을 `presented_content`로 material approval에 저장하고 그 정확한 내용에 대해 사용자가 승인할 때까지 Reviewer 근거로 쓰지 않는다. 같은 source/claim ID의 본문이 바뀌면 새 내용으로 다시 제시하고 다시 승인받는다. Reviewer는 승인 기록의 snapshot만 사용하며 live ID를 통해 내용을 조용히 바꾸지 않는다.
4. 사용자가 자료를 거부하면 해당 자료를 제외한다. 대체 자료를 찾거나 충분한 근거가 없으면 결정을 보류한다. Material use approval은 Principle approval과 별개다.
5. 가정, 불필요한 복잡성, 근거가 부족한 주장, 지표, 성장 경계, 운영 및 실패 처리를 질문으로 challenge한다. objection마다 statement와 provenance를 남기고 정답을 제시하지 않는다.
6. 아래 일곱 조건을 검토한다: requirements, targets, alternatives, tradeoffs, evidence, boundary, answered_objections.
7. Reviewer가 사용한 모든 새 material ID를 review에 기록하고, 각 ID에 맞는 별도 user use-approval record를 연결한다. 하나라도 승인되지 않았거나 자료 hash가 달라지면 gate를 통과시키지 않는다.
8. 결과는 `ACCEPTED`, `NEEDS_DEFENSE`, `NEEDS_EVIDENCE`, `NEEDS_REVISION` 중 하나로 기록한다. 미해결 objection이나 필요한 자료가 남으면 gate를 통과시키지 않는다.
9. 사용자가 Learning에서 Normal로 명시 전환하면 전환 이력과 unresolved gate를 보존하고 Normal workflow를 이어간다. 승인 대기 상태도 resume 후 유지한다.

## 금지

- 사용자의 제안을 사용자의 승인으로 간주하지 않는다.
- 미승인 자료를 근거로 인용하지 않는다.
- 거부 자료를 다시 포함하거나 Principle 승인과 자료 사용 승인을 합치지 않는다.
- Reviewer가 objection의 답, architecture 선택 또는 의미상 충분성 판정을 대신하지 않는다.
- 새 Source/Claim을 project Knowledge registry에 게시하지 않는다.
