# Architecture 결정 단계

Product Spec 이후 Architecture Spec을 작성하기 전까지의 결정 순서를 정한다.

1. 기술 선택 전 적용 가능한 기능·구축 시간·운영·비용·데이터 제어·성능·변경 가능성 기준을 필수와 선호, 우선순위로 정한다. 기존 사용자 답변과 명시적 위임을 재사용하고 독립 질문을 묶는다. 적용되는 System Targets를 확정하고 `docs/specs/<plan-set-id>/system-targets.yaml`에 기록한다.
2. material technology choice가 있으면 System Targets에 `decision_metadata.decision_layer_version: 2`를 기록하고 Architecture Decision ID를 부여한다.
3. 중요한 기술 선택이 미완료이거나 기존 결정이 요구·제약을 충족하지 못할 때만 [기술 선택](../../../../.codex/internal-skills/technology-selection/GUIDE.md)을 읽고 수행한다. 유효한 기존 결정은 재사용한다.
4. 합의된 Architecture 결정을 [Architecture Spec 절차](../../../internal-skills/architecture-spec/GUIDE.md)에 넘긴다.

이 문서는 Architecture 결정의 순서를 소유한다. 근거 조사와 후보 비교는 내부 기술 선택 GUIDE, 기술 검토와 Spec 작성은 Architecture Spec GUIDE가 소유한다.

각 결정의 정본은 `docs/specs/<plan-set-id>/architecture-decisions/<decision-id>.yaml`이며 `.codex/schemas/decision/architecture-decision.schema.yaml`을 따른다. 승인 전에는 `proposed`로 작성한다. 실제 답변 또는 위임의 원문을 `selection.user_choice`에 기록하고, 정본 답변이 저장된 뒤 `node .codex/scripts/harness-decision-gate.mjs approve --ticket <plan-set-id> --decision <decision-id> --answers runtime/executions/<execution-id>/decision-answers.json --question <question-id>`를 호출한다. 원 요청에서 명시적으로 위임한 경우에는 위임 원문을 `selection.user_choice`에 그대로 기록하고 답변 파일 대신 `--delegated true`를 전달한다. 실행기는 원 요청 또는 답변과 선택을 대조하고 정본 결정의 hash를 계산해 승인에 연결한다. 위임의 실제 범위와 의미는 caller가 확인한다. 결정이 바뀌면 다시 실제 선택 또는 위임을 확인한다. 모델이 hash를 복사하지 않는다.
