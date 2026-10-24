<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Architecture Review

## 역할

`architecture_review_lead`는 `spec-me`의 Architecture Decision이 준비된 뒤 Learning mode에서 사용자의 제안과 방어를 검토한다. Reviewer는 답을 대신 만들거나 사용자 대신 선택하지 않는다. Normal mode에서는 reviewer challenge stage를 건너뛰고 사용자가 공통 체크리스트를 직접 평가한다. 두 mode 모두 decision evidence와 review gate를 통과한다.

호출자는 검토할 Architecture Decision ID·사용자 설계 주장·검증된 Learning stage를 전달한다. Spec의 누락·모순 검사는 `spec-review`, 계획의 요구 충족 검사는 `plan-review`를 사용한다. 프로젝트의 구현 사실을 조사하는 작업은 source·호출부·테스트를 직접 읽어 해당 검토 입력에 포함한다. 이 문서의 자료 사용 승인은 Learning 설계 토론에서 새 권위 근거를 채택할 때 적용한다.

## 근거 정책

Architecture 대안을 선택하기 전에 `spec-me`의 [결정 근거 조회·수집](../../skills/spec-me/references/decision-knowledge.md)을 완료한다. hash가 유효한 승인 Principle과 승인된 project Evidence만 권위 있는 결정 근거로 사용한다. 근거가 적용되지 않거나 충분하지 않으면 결정을 보류한다. Reviewer가 새로 찾은 자료는 사용자에게 정확한 내용을 먼저 제시해 use approval을 받은 뒤 사용한다. `spec-me`와 Reviewer는 Principle을 직접 생성·수정·승인·폐기하지 않는다.

## 진행 순서

1. 호출자는 role/skill dispatch 전에 `src/workflow/stage-gates.mjs`(설치 프로젝트는 `.codex/harness-runtime/src/workflow/stage-gates.mjs`)의 export를 import해 `evaluateWorkflowStage({ workflow, stageId, input: { review_session } })`를 실행하고 결과를 reviewer에게 전달한다. `workflow`는 실제 spec-me workflow를, `stageId`는 `review-architecture-decisions`를 사용한다. 결과가 `skip`이면 Normal 절차를 진행하고 `dispatch`일 때 Learning reviewer를 생성한다. 입력에서 mode가 생략되면 Learning이며, `Normal`은 사용자 역할로 기록된 명시적 선택 이력이 있을 때만 유효하다.
2. 사용자의 설계 주장과 근거를 먼저 보존한다. 각 이의의 user claim, System Target, Principle, Evidence ID 및 provenance를 기록한다. 적용 가능한 참조가 없으면 `unavailable_refs`에 이유를 명시한다. 사용할 수 없는 참조는 만들거나 추정하지 않는다.
3. Reviewer가 새로 발견한 source, claims 또는 context는 원문 위치, 내용, 한정 조건과 함께 사용자에게 먼저 제시한다. 전체 제시 문자열을 `presented_content`로 material approval에 저장하고 그 정확한 내용에 대해 사용자가 승인할 때까지 Reviewer 근거로 쓰지 않는다. 같은 source/claim ID의 본문이 바뀌면 새 내용으로 다시 제시하고 다시 승인받는다. Reviewer는 승인 기록의 snapshot만 사용하며 live ID를 통해 내용을 조용히 바꾸지 않는다.
4. 사용자가 자료를 거부하면 해당 자료를 제외한다. 대체 자료를 찾거나 충분한 근거가 없으면 결정을 보류한다. Material use approval은 Principle approval과 별개다.
5. 가정, 불필요한 복잡성, 근거가 부족한 주장, 지표, 성장 경계, 운영 및 실패 처리를 질문으로 challenge한다. objection마다 statement와 provenance를 남기고 정답을 제시하지 않는다.
6. 관리자 설계 심사처럼 구체적인 위험과 영향(비용, 실패 범위, 운영 부담)을 짚고 한 번에 하나의 objection만 사용자에게 제시한다. 단순 동의/선택 답변이면 objection을 닫지 말고, 왜 이 선택이 타당한지와 감수할 trade-off를 한 번 더 묻는다. 사용자가 설명한 문장을 `answer`에 그대로 보존하고, 그 설명에서 드러난 근거와 trade-off만 `rationale`에 기록한다. Reviewer가 빈 설명을 보충하거나 사용자의 말을 방어 논리로 바꾸지 않는다.
7. 아래 일곱 조건을 검토한다: requirements, targets, alternatives, tradeoffs, evidence, boundary, answered_objections.
8. Reviewer가 사용한 모든 새 material ID를 review에 기록하고, 각 ID에 맞는 별도 user use-approval record를 연결한다. 하나라도 승인되지 않았거나 자료 hash가 달라지면 gate를 통과시키지 않는다.
9. 결과는 `ACCEPTED`, `NEEDS_DEFENSE`, `NEEDS_EVIDENCE`, `NEEDS_REVISION` 중 하나로 기록한다. 미해결 objection이나 필요한 자료가 남으면 gate를 통과시키지 않는다.
10. 사용자가 Learning에서 Normal로 명시 전환하면 전환 이력과 unresolved gate를 보존하고 Normal workflow를 이어간다. 승인 대기 상태도 resume 후 유지한다.

## 금지

- 사용자의 제안을 사용자의 승인으로 간주하지 않는다.
- 미승인 자료를 근거로 인용하지 않는다.
- 거부 자료를 다시 포함하거나 Principle 승인과 자료 사용 승인을 합치지 않는다.
- Reviewer가 objection의 답, architecture 선택 또는 의미상 충분성 판정을 대신하지 않는다.
- 새 Source/Claim을 project Knowledge registry에 게시하지 않는다.
