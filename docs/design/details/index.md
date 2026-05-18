# DDD 설계 인덱스

## 1. 문서 링크
- 도메인 모델: docs/design/details/도메인모델.md
- 어그리거트: docs/design/details/어그리거트.md
- 애플리케이션 서비스: docs/design/details/애플리케이션서비스.md
- 바운디드 컨텍스트: docs/design/details/바운디드컨텍스트.md

## 2. 전체 구성 요약
- 설계 입력: `docs/design/이벤트 스토밍.md`, `docs/design/유스케이스.md`, `docs/design/요구사항.md`
- 핵심 도메인 흐름: End user edits an expression, explicitly triggers calculation, receives either formatted numeric result or `ERROR`, may clear state, and may recover from app failure by manual refresh to an empty state.
- 주요 경계: One `CalculatorContext`, one `CalculatorSessionAggregate`, one aggregate root `CalculatorSession`, one domain service `ExpressionEvaluationService`, and one repository interface with a current file-backed adapter plan.

## 3. 컴포넌트 카탈로그
### 3.1 바운디드 컨텍스트
|BC|책임|주요 컴포넌트|
|---|---|---|
|CalculatorContext|Own calculator page-session behavior for expression editing, explicit calculation, error display, clear/reset, and failure recovery.|CalculatorSessionAggregate, CalculatorCalculationAppService, CalculatorEditingAppService, CalculatorResetAppService, CalculatorRecoveryAppService, ExpressionEvaluationService, CalculatorSessionRepository|

### 3.2 어그리거트
|어그리거트|루트|소속 BC|핵심 불변식|
|---|---|---|---|
|CalculatorSessionAggregate|CalculatorSession|CalculatorContext|A stale result cannot survive expression change; success/error visibility are mutually exclusive; failure-visible and normal interaction states are mutually exclusive; clear/recovery reset expression and result together.|

### 3.3 엔티티
|엔티티|소속 어그리거트/BC|식별 기준|
|---|---|---|
|CalculatorSession|CalculatorSessionAggregate / CalculatorContext|`sessionId` for one page-session lifecycle|

### 3.4 값 객체
|VO|사용 위치|핵심 검증 규칙|
|---|---|---|
|ExpressionText|CalculatorSession.currentExpression|Only in-scope arithmetic tokens; keep entered content as-is; no auto-correction.|
|CalculationResult|CalculatorSession.currentResult|Represents successful numeric value; long decimal output formats to 10 decimal places when required.|
|DisplayStatus|CalculatorSession.visibleStatus|Must be one of `EMPTY`, `EDITING`, `RESULT_VISIBLE`, `ERROR_VISIBLE`, `FAILURE_VISIBLE`.|
|EvaluationOutcome|Input to `CalculatorSession.applyCalculationOutcome(...)`|Contains either success value or failure reason, never both.|
|FailureState|CalculatorSession.failureStatus|Represents manual-refresh-required failure visibility state.|

### 3.5 도메인 서비스
|도메인 서비스|책임|호출 주체|관련 유스케이스|
|---|---|---|---|
|ExpressionEvaluationService|Evaluate full arithmetic expressions with precedence and produce `EvaluationOutcome`.|CalculatorCalculationAppService|UC-01|

### 3.6 애플리케이션 서비스
|애플리케이션 서비스|소속 BC|오케스트레이션 유스케이스|호출 컴포넌트|비즈니스 로직 노출 방지 규칙|
|---|---|---|---|---|
|CalculatorCalculationAppService|CalculatorContext|UC-01|CalculatorSessionRepository, ExpressionEvaluationService, CalculatorSessionAggregate|Must not parse expressions or decide success/error rules itself.|
|CalculatorEditingAppService|CalculatorContext|UC-02|CalculatorSessionRepository, CalculatorSessionAggregate|Must not directly clear stale results or mutate aggregate fields.|
|CalculatorResetAppService|CalculatorContext|UC-03|CalculatorSessionRepository, CalculatorSessionAggregate|Must not directly blank state fields.|
|CalculatorRecoveryAppService|CalculatorContext|UC-04|CalculatorSessionRepository, CalculatorSessionAggregate|Must not encode failure/recovery rules outside aggregate methods.|

### 3.7 포트/외부 협력 후보
|포트/협력 객체|종류|호출 주체|목적|관련 유스케이스|
|---|---|---|---|---|
|CalculatorSessionRepository|Repository interface|All calculator app services|Load/save current session aggregate through an abstraction.|UC-01, UC-02, UC-03, UC-04|
|FileBackedCalculatorSessionRepository|Repository adapter|Infrastructure bound to repository interface|Provide current concrete persistence strategy behind the repository interface.|UC-01, UC-02, UC-03, UC-04|
|FailureDetectionInput|Application input boundary|CalculatorRecoveryAppService|Deliver app-load/runtime failure signal from runtime/UI layer.|UC-04|

## 4. 유스케이스별 커뮤니케이션
|유스케이스|애플리케이션 서비스|참여 어그리거트/도메인 서비스|BC 간 커뮤니케이션|외부 협력|비고|
|---|---|---|---|---|---|
|UC-01 End user calculates an arithmetic expression|CalculatorCalculationAppService|CalculatorSessionAggregate, ExpressionEvaluationService|None|CalculatorSessionRepository|Explicit calculate only; returns formatted numeric result or `ERROR`.|
|UC-02 End user edits the current expression|CalculatorEditingAppService|CalculatorSessionAggregate|None|CalculatorSessionRepository|Expression change clears stale result immediately.|
|UC-03 End user clears the calculator state|CalculatorResetAppService|CalculatorSessionAggregate|None|CalculatorSessionRepository|Resets expression and result together to empty state.|
|UC-04 End user retries calculator use after an app failure|CalculatorRecoveryAppService|CalculatorSessionAggregate|None|CalculatorSessionRepository, FailureDetectionInput|Failure remains visible until successful manual refresh returns empty state.|

## 5. 설계 규칙 요약
- 도메인 규칙 위치: Validation and state-transition rules stay in `CalculatorSession`, value objects, and `ExpressionEvaluationService`.
- 상태 변경 경로: UI/runtime input -> application service -> repository interface load -> aggregate root method -> repository interface save -> returned view state.
- 외부 협력 처리: Current scope has no external BC or networked system; repository adapter and runtime failure input stay outside the domain model.
- BC 경계 보호: `CalculatorContext` owns all calculator meanings and state changes; no direct mutation across non-existent BC boundaries is allowed.

## 6. 확인 필요
- Whether `ExpressionText` should preserve or normalize whitespace.
- Whether empty expression is represented by absent `ExpressionText` or an empty `ExpressionText` instance.
- Whether `FailureState` should remain separate from `DisplayStatus`.
- Whether app-load failure and runtime failure should share one recovery entrypoint or separate methods in `CalculatorRecoveryAppService`.
- Detailed command/event names remain summary-level because per-use-case event-storming slice documents were outside the allowed read scope.
