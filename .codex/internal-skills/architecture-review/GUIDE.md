<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Architecture Review

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [공통 skill 실행 계약](../skill-execution/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

## 역할

`architecture_review_lead`는 `spec-me`의 Architecture Decision이 준비된 뒤 Learning mode에서 제안과 근거를 검토한다. 질문 여부는 [grilling](../../../.codex/skills/grilling/SKILL.md)의 기준을 따른다. 위임된 선택은 작성자가 기존 제약과 근거에 맞춰 정하고 reviewer가 이를 평가한다. Reviewer는 자신의 분석을 사용자 발언으로 기록하지 않는다. Normal mode에서는 reviewer challenge stage를 건너뛰고 사용자가 공통 체크리스트를 직접 평가한다. 두 mode 모두 decision evidence와 review gate를 통과한다.

호출자는 검토할 Architecture Decision ID·실제 사용자 선택 또는 위임·검증된 Learning stage를 전달한다. 위임한 세부 선택은 작성자의 근거와 reviewer의 판단으로 검토하며 사용자의 별도 설계 주장이나 방어를 만들어내지 않는다. Spec의 누락·모순 검사는 `spec-review`, 계획의 요구 충족 검사는 `plan-review`를 사용한다. 프로젝트의 구현 사실을 조사하는 작업은 source·호출부·테스트를 직접 읽어 해당 검토 입력에 포함한다. 이 문서의 자료 사용 승인은 Learning 설계 토론에서 새 권위 근거를 채택할 때 적용한다.

Decision 동의의 현재성은 `docs/specs/<plan-set-id>/architecture-decisions/<decision-id>.yaml`의 정본 객체를 기준으로 확인한다. 작성자와 동일하게 worktree에서 `node .codex/scripts/harness-decision-gate.mjs decision_subject_hash --ticket <plan-set-id> --decision <decision-id>`를 사용하고 승인 기록 및 실제 Decision gate와 대조한다. 임시 Markdown 본문·해시 표시 줄을 직접 해시하지 않는다. 정본 객체가 없거나 기존 동의가 다른 표현의 해시에 묶였다면 작성자에게 정본과 동의 범위를 확인하도록 반환하고 서로 다른 값을 비교해 변경이나 승인을 추정하지 않는다.

## 근거 정책

Architecture 대안을 선택하기 전에 `spec-me`의 [결정 근거 조회·수집](../../../.codex/skills/spec-me/references/decision-knowledge.md)을 완료한다. hash가 유효한 승인 Principle과 승인된 project Evidence만 권위 있는 결정 근거로 사용한다. 근거가 적용되지 않거나 충분하지 않으면 결정을 보류한다. Reviewer가 새로 찾은 자료는 사용자에게 정확한 내용을 먼저 제시해 use approval을 받은 뒤 사용한다. `spec-me`와 Reviewer는 Principle을 직접 생성·수정·승인·폐기하지 않는다.

근거의 원문 검증과 신뢰성 평가는 근거 수집·검증 절차의 결과를 사용한다. Decision reviewer는 검증된 근거가 해당 선택과 연결되고 적용 가능한지 확인한다. 근거와 연결 관계가 그대로면 원문을 다시 읽거나 기존 근거의 신뢰성을 반복 심사하지 않는다. 근거 내용이 변경되었거나 구체적인 모순·적용 범위 문제가 발견된 경우 영향을 받는 근거만 다시 확인한다.

승인된 Principle은 적용 가능한 것이 있을 때만 참조한다. Principle이 없다는 이유만으로 새 Principle이나 승인을 요구하지 않는다. reviewer의 material-use approval은 해당 리뷰에서 새로 사용한 material ID에만 적용한다. `material_ids`가 비어 있으면 source 수집 기록이 존재한다는 이유만으로 reviewer의 자료별 승인 gate를 새로 만들지 않는다. Decision에 필수인 Evidence와 그 유효성은 별도로 확인한다.

## 진행 순서

1. 호출자는 role/skill dispatch 전에 `src/workflow/stage-gates.mjs`(설치 프로젝트는 `.codex/harness-runtime/src/workflow/stage-gates.mjs`)의 export를 import해 `evaluateWorkflowStage({ workflow, stageId, input: { review_session } })`를 실행하고 결과를 reviewer에게 전달한다. `workflow`는 실제 spec-me workflow를, `stageId`는 `review-architecture-decisions`를 사용한다. 결과가 `skip`이면 Normal 절차를 진행하고 `dispatch`일 때 Learning reviewer를 생성한다. 입력에서 mode가 생략되면 Learning이며, `Normal`은 사용자 역할로 기록된 명시적 선택 이력이 있을 때만 유효하다.
2. 사용자의 설계 주장과 근거를 먼저 보존한다. 각 이의의 user claim, System Target, Principle, Evidence ID 및 provenance를 기록한다. 적용 가능한 참조가 없으면 `unavailable_refs`에 이유를 명시한다. 사용할 수 없는 참조는 만들거나 추정하지 않는다.
3. Reviewer가 새로 발견한 source, claims 또는 context는 원문 위치, 내용, 한정 조건과 함께 사용자에게 먼저 제시한다. 전체 제시 문자열을 `presented_content`로 material approval에 저장하고 그 정확한 내용에 대해 사용자가 승인할 때까지 Reviewer 근거로 쓰지 않는다. 같은 source/claim ID의 본문이 바뀌면 새 내용으로 다시 제시하고 다시 승인받는다. Reviewer는 승인 기록의 snapshot만 사용하며 live ID를 통해 내용을 조용히 바꾸지 않는다.
4. 사용자가 자료를 거부하면 해당 자료를 제외한다. 대체 자료를 찾거나 충분한 근거가 없으면 결정을 보류한다. Material use approval은 Principle approval과 별개다.
5. 가정, 불필요한 복잡성, 근거가 부족한 주장, 지표, 성장 경계, 운영 및 실패 처리를 검토한다. [grilling](../../../.codex/skills/grilling/SKILL.md) 기준에 따라 사용자에게 물어야 할 선택을 구분하고, 담당자가 해결할 finding은 작성자에게 돌려보낸다.
6. 사용자 결정이 필수인 objection은 구체적인 영향과 선택지를 한 번에 하나씩 제시한다. 실제 사용자 설명은 `answer`에 그대로 보존하고, reviewer 또는 작성자의 분석은 별도 근거로 기록한다. 사용자 발언을 만들어내거나 동의 범위를 확대하지 않는다.
7. 각 Decision의 리뷰 보고서(`architecture_review` artifact)에 다음 일곱 항목을 각각 한 줄로 기록한다: requirements, targets, alternatives, tradeoffs, evidence, boundary, answered_objections. 형식은 `- [x] AD-001 / requirements — 확인한 범위와 근거 위치` 또는 `- [ ] AD-001 / evidence — 미해결 이유와 필요한 작업`이다. `[x]`는 해당 Decision의 해당 범위가 실제로 통과한 경우만 사용하고, `[ ]`는 미검토·미해결 항목에 사용한다. 각 줄에 확인한 문서의 구간 또는 finding과 근거 위치를 기록한다. 질문으로 중단할 때도 현재까지의 체크박스를 반환한다. 전체 리뷰 결과와 결정 승인 gate는 별도로 판단한다.
8. Reviewer가 사용한 모든 새 material ID를 review에 기록하고, 각 ID에 맞는 별도 user use-approval record를 연결한다. 하나라도 승인되지 않았거나 자료 hash가 달라지면 gate를 통과시키지 않는다.
9. 결과는 `ACCEPTED`, `NEEDS_DEFENSE`, `NEEDS_EVIDENCE`, `NEEDS_REVISION` 중 하나로 기록한다. 미해결 objection이나 필요한 자료가 남으면 gate를 통과시키지 않는다.
10. 사용자가 Learning에서 Normal로 명시 전환하면 전환 이력과 unresolved gate를 보존하고 Normal workflow를 이어간다. 승인 대기 상태도 resume 후 유지한다.

## 재검토 범위

이전 `architecture_review` 보고서의 Decision별 체크박스, finding과 근거 위치를 먼저 읽는다. 새로운 reviewer는 `[ ]` 항목, 변경된 내용과 그 변경이 직접 영향을 미치는 항목만 검토한다. 영향받지 않고 근거가 그대로인 `[x]` 항목은 기존 근거를 참조해 유지하고 원본 항목을 반복해 읽지 않는다. 변경으로 영향을 받는 `[x]`는 다시 열고 관련 구간을 확인한다. 이전 보고서에 체크박스가 없으면 명시적인 통과와 근거가 확인되는 항목만 인계하고, 판단할 수 없는 항목은 `[ ]`로 둔다. 변경 범위나 영향이 모호하면 관련 항목을 다시 검토한다. 새 보고서에 유지·재검토한 항목의 근거와 미해결 항목을 모두 기록한다. 이전 reviewer의 결과나 사용자 동의를 새로 만들어내지 않는다.

## 금지

- 사용자의 제안을 사용자의 승인으로 간주하지 않는다.
- 미승인 자료를 근거로 인용하지 않는다.
- 거부 자료를 다시 포함하거나 Principle 승인과 자료 사용 승인을 합치지 않는다.
- Reviewer가 사용자 선택이나 답변을 만들어내지 않는다. 위임된 선택과 구현 세부사항은 작성자가 정하고 reviewer가 근거와 영향을 평가한다.
- 새 Source/Claim을 project Knowledge registry에 게시하지 않는다.
