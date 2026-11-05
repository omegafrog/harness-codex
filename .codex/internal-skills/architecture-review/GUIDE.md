<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Architecture Review

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [실행 조율](../skill-execution/GUIDE.md)에 따라 `harness-skill-execution.mjs binding`이 스킬의 binding과 setup 설정에서 model·effort를 해석한다. 지정된 작업을 수행하고 필요한 내부 작업은 [실행 조율](../skill-execution/GUIDE.md)에 따라 서브에이전트에 위임한다. 사용자 결정과 workflow 단계 전환은 상위 caller에 반환한다.

## 역할

`architecture_review_lead`는 `spec-me`의 Architecture Decision이 준비된 뒤 Learning mode에서 제안과 근거를 검토한다. 질문 여부는 [grilling](../../../.codex/internal-skills/grilling/GUIDE.md)의 기준을 따른다. 위임된 선택은 작성자가 기존 제약과 근거에 맞춰 정하고 reviewer가 이를 평가한다. Reviewer는 자신의 분석을 사용자 발언으로 기록하지 않는다. Normal mode에서는 reviewer challenge stage와 별도 체크리스트 인증을 생략한다. 두 mode 모두 실제 선택과 decision gate를 확인한다.

호출자는 검토할 Architecture Decision ID·실제 사용자 선택 또는 위임·검증된 Learning stage를 전달한다. 위임한 세부 선택은 작성자의 근거와 reviewer의 판단으로 검토하며 사용자의 별도 설계 주장이나 방어를 만들어내지 않는다. Spec의 누락·모순 검사는 `spec-review`, 계획의 요구 충족 검사는 `plan-review`를 사용한다. 프로젝트의 구현 사실을 조사하는 작업은 source·호출부·테스트를 직접 읽어 해당 검토 입력에 포함한다.

Decision 동의의 현재성은 정본 Decision과 실행기가 기록한 승인으로 확인한다. Decision이 바뀌면 기존 동의를 임의로 옮기지 않는다.

## 근거와 진행

일반 출처는 해당 주장, 원문 위치, 적용 조건과 확인일을 기록하고 자료 사용 승인을 별도로 요구하지 않는다. 승인된 프로젝트 Knowledge는 재사용하며 공통 Knowledge 게시만 `knowledge-harvest`에 넘긴다.

Learning을 사용자가 요청했을 때 비교 기준·후보·근거·트레이드오프와 미해결 이의를 검토한다. 새로운 사실은 출처와 조건을 밝혀 설명하고, 사용자 판단이 필요한 독립 질문을 묶어 실제 답변을 보존한다. reviewer가 사용자 발언이나 동의를 만들지 않는다. 중대한 미해결 finding은 작성자에게 반환하고 실제 선택과 Decision 승인 gate를 통과해야 한다. Normal은 별도 체크리스트 인증을 요구하지 않는다.

## 결과와 재검토

Learning 검토 결과는 `docs/specs/<plan-set-id>/architecture-reviews/<review-id>.yaml`에 `.codex/schemas/decision/review.schema.yaml` 형식으로 남기고 Decision의 `review_id`로 연결한다. `findings`는 severity, description과 구체적인 evidence를 담는다. 중대한 finding이 있거나 outcome이 `ACCEPTED`가 아니면 완료하지 않는다. 재검토 시 변경된 부분과 미해결 지적, 직접 영향 관계를 다시 확인한다. 사용자 답변과 동의 범위는 실제 기록을 사용한다.

## 금지

- 사용자의 제안을 사용자의 승인으로 간주하지 않는다.
- Reviewer가 사용자 선택이나 답변을 만들어내지 않는다. 위임된 선택과 구현 세부사항은 작성자가 정하고 reviewer가 근거와 영향을 평가한다.
- 새 Source/Claim을 project Knowledge registry에 게시하지 않는다.
