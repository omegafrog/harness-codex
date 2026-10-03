# ADR-013: 실행 관측 목적과 Decision 연결

- 상태: Accepted
- 결정일: 2026-10-03
- 근거: 사용자 결정, `docs/specs/506/product-spec.md` BR-014 및 AC-012

## Context

Harness가 실행한 테스트에는 서로 다른 목적이 있다. 단위·회귀 테스트는 코드가 기존 계약과 동작을 유지하는지 확인한다. 성능 기준이나 특정 아키텍처 조건을 평가하는 테스트는 승인된 Architecture Decision의 조건을 확인한다. 결과 값만으로는 어느 목적인지, 어떤 Decision을 검증하는지 신뢰성 있게 판단할 수 없다.

기존 Evidence 계약은 모든 Evidence에 `decision_ids`를 요구해 Decision과 무관한 코드 정합성 확인도 Decision에 억지로 연결하게 만들 수 있다.

## Decision

Harness 실행을 Knowledge Evidence로 수집할 때 실행 정의가 목적을 명시한다.

- `code_validation`: 코드 정합성·단위·회귀 동작을 확인한다. Decision ID 없이 수집할 수 있으며, 이 Evidence는 코드 검증 이력으로만 사용하고 Decision 조건의 근거로 제시하지 않는다.
- `decision_validation`: 특정 Architecture Decision의 조건을 확인한다. 하나 이상의 실제 `decision_ids`를 실행 정의에서 제공해야 하며, 참조가 해석되지 않으면 Evidence를 수집하지 않는다.

목적이나 Decision 연결을 실행 출력, metric 이름, 성공/실패 결과에서 추론하지 않는다. 목적이 선언되지 않았거나 알 수 없는 실행은 자동 Knowledge Evidence 후보로 승격하지 않고 별도 진단을 남긴다. `execution_purpose`가 없는 기존 및 수동 Evidence는 기존 Decision 참조 계약을 유지한다.

## Consequences

- 단위·회귀 검증 결과는 실제 Decision이 없어도 정규화·사용자 승인 후 Evidence로 보존할 수 있다.
- Decision을 뒷받침하려고 작성한 성능·조건 검증은 대상 Decision ID를 명시해야 한다.
- 저장 형식과 검증기는 `execution_purpose`의 조건부 Decision ID 규칙을 함께 검증한다.
- Decision을 검증하려는 실행이 `code_validation`으로 잘못 선언되면 분류 책임이 실행 정의 작성자에게 있으므로, Product Spec과 plan/test 계약에서 목적 선언을 명시한다.
