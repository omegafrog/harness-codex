# UC-001. End User Calculates an Arithmetic Expression 이벤트 스토밍

## 1. 개요
- 입력 ChangeSet: `docs/changes/active/CHG-20260507-001.md`
- 입력 유스케이스: `docs/use-cases/UC-001/use-case.md`
- 입력 E2E 목표: `docs/use-cases/UC-001/e2e-goal.md`
- Canonical summary/index: `docs/design/이벤트 스토밍.md` (not present)
- 산출물 목적: affected UC를 초기 커맨드로 삼아 해당 UC 구현에 필요한 이벤트, 정책, 커맨드, 시스템, 외부 시스템, 규칙을 추출한다.

## 2. 범례
|유형|의미|작성 규칙|
|---|---|---|
|🟦 커맨드|Instruction sent to the system to perform one action|Write in imperative form|
|🟧 이벤트|Fact that happened in the domain|Write in past tense|
|🟪 정책|Rule that decides the next action after an event|Write as a condition or decision criterion|
|⬛ 시스템|Owning domain area for commands, events, and policies|Write as a domain or system name|
|🟩 외부 시스템|Collaborating system outside the domain boundary|Write as an external system name|

## 3. 시작 유스케이스
- 유스케이스: `UC-001`. End User Calculates an Arithmetic Expression
- 액터: End user
- 목표: Evaluate an entered arithmetic expression and display either a numeric result or `ERROR`
- 초기 커맨드: 🟦 Evaluate the arithmetic expression

### 사전 조건
- The calculator page loaded successfully.
- The current page session is active in a supported desktop browser.
- The user has entered an expression with keyboard input, on-screen buttons, or both.

### 종료 조건
- 성공: A numeric result is displayed, and long decimal output is formatted to 10 decimal places when needed.
- 실패: `ERROR` is displayed for an invalid expression, an incomplete expression, or an invalid operation.

## 4. 흐름
### [Flow: 기본 흐름]
🟦 Evaluate the arithmetic expression
→ 🟧 Arithmetic expression evaluation was requested
→ 🟪 If the expression is syntactically valid
→ 🟦 Parse the arithmetic expression
→ 🟧 Arithmetic expression was parsed
→ 🟪 If the parsed expression is semantically evaluable
→ 🟦 Evaluate the parsed expression with operator precedence
→ 🟧 Arithmetic expression was evaluated
→ 🟪 If the numeric result needs decimal formatting
→ 🟦 Format the numeric result to 10 decimal places
→ 🟧 Numeric result was formatted
→ 🟦 Display the numeric result
→ 🟧 Numeric result was displayed

---
### [Flow: 예외 흐름]
🟦 Evaluate the arithmetic expression
→ 🟧 Arithmetic expression evaluation was requested
→ 🟪 If the expression is syntactically invalid or incomplete
→ 🟦 Display ERROR
→ 🟧 ERROR was displayed

---
### [Flow: 예외 흐름]
🟦 Evaluate the parsed expression with operator precedence
→ 🟧 Arithmetic expression evaluation failed
→ 🟪 If evaluation failed because of an invalid operation
→ 🟦 Display ERROR
→ 🟧 ERROR was displayed

---
## 5. 도메인 요소 (통합)
|유형|내용|트리거|결과|시스템|비고|
|---|---|---|---|---|---|
|🟦|Evaluate the arithmetic expression|End user|Arithmetic expression evaluation was requested|Calculator UI|Initial command from `UC-001`; triggered by `=` or `Calculate`|
|🟧|Arithmetic expression evaluation was requested|Evaluate the arithmetic expression|If the expression is syntactically valid; If the expression is syntactically invalid or incomplete|Calculator UI|Explicit calculation trigger only|
|🟪|If the expression is syntactically valid|Arithmetic expression evaluation was requested|Parse the arithmetic expression|Expression Evaluation Engine|Validation branch for accepted input shape|
|🟦|Parse the arithmetic expression|If the expression is syntactically valid|Arithmetic expression was parsed|Expression Evaluation Engine|Supports numbers, `+`, `-`, `*`, `/`, parentheses, decimals, and negative numbers|
|🟧|Arithmetic expression was parsed|Parse the arithmetic expression|If the parsed expression is semantically evaluable|Expression Evaluation Engine|Successful parse only|
|🟪|If the parsed expression is semantically evaluable|Arithmetic expression was parsed|Evaluate the parsed expression with operator precedence|Expression Evaluation Engine|Allows execution only for evaluable parsed input|
|🟦|Evaluate the parsed expression with operator precedence|If the parsed expression is semantically evaluable|Arithmetic expression was evaluated; Arithmetic expression evaluation failed|Expression Evaluation Engine|Frontend-only evaluation; no backend or third-party calls|
|🟧|Arithmetic expression was evaluated|Evaluate the parsed expression with operator precedence|If the numeric result needs decimal formatting; Display the numeric result|Expression Evaluation Engine|Success event before presentation|
|🟪|If the numeric result needs decimal formatting|Arithmetic expression was evaluated|Format the numeric result to 10 decimal places|Expression Evaluation Engine|Applied only when long decimal output must be bounded|
|🟦|Format the numeric result to 10 decimal places|If the numeric result needs decimal formatting|Numeric result was formatted|Expression Evaluation Engine|Formats long decimal output only|
|🟧|Numeric result was formatted|Format the numeric result to 10 decimal places|Display the numeric result|Expression Evaluation Engine|Passes formatted value to the UI|
|🟦|Display the numeric result|Arithmetic expression was evaluated; Numeric result was formatted|Numeric result was displayed|Calculator UI|Displays formatted or unformatted numeric output|
|🟧|Numeric result was displayed|Display the numeric result|None|Calculator UI|Successful termination event|
|🟪|If the expression is syntactically invalid or incomplete|Arithmetic expression evaluation was requested|Display ERROR|Expression Evaluation Engine|No auto-correction is allowed|
|🟧|Arithmetic expression evaluation failed|Evaluate the parsed expression with operator precedence|If evaluation failed because of an invalid operation|Expression Evaluation Engine|Failure event for invalid operation branch|
|🟪|If evaluation failed because of an invalid operation|Arithmetic expression evaluation failed|Display ERROR|Expression Evaluation Engine|Failure branch after evaluation attempt|
|🟦|Display ERROR|If the expression is syntactically invalid or incomplete; If evaluation failed because of an invalid operation|ERROR was displayed|Calculator UI|User-visible failure output|
|🟧|ERROR was displayed|Display ERROR|None|Calculator UI|Failure termination event|
|🟩|None|None|None|External|No external systems participate in this UC|

---
## 6. 외부 시스템
|시스템|연동 목적|관련 유스케이스|비고|
|---|---|---|---|
|None|None|`UC-001`|None|

---
## 7. 규칙 (Invariant)
- Calculation starts only after the user explicitly triggers `=` or `Calculate`.
- The system must not auto-correct a syntactically invalid or incomplete expression; it must display `ERROR`.
- The evaluation result must follow operator precedence for the supported arithmetic grammar.
- Long decimal output must be displayed using 10 decimal places.
- Calculation state remains in browser memory only for the current page session.
- The UC must stay frontend-only and must not call backend services or third-party calculation providers.

## 8. UC 도메인 요소 요약
### 8.1 커맨드
|커맨드|출처 유스케이스|시스템|
|---|---|---|
|Evaluate the arithmetic expression|`UC-001`|Calculator UI|
|Parse the arithmetic expression|`UC-001`|Expression Evaluation Engine|
|Evaluate the parsed expression with operator precedence|`UC-001`|Expression Evaluation Engine|
|Format the numeric result to 10 decimal places|`UC-001`|Expression Evaluation Engine|
|Display the numeric result|`UC-001`|Calculator UI|
|Display ERROR|`UC-001`|Calculator UI|

### 8.2 이벤트
|이벤트|출처 유스케이스|시스템|
|---|---|---|
|Arithmetic expression evaluation was requested|`UC-001`|Calculator UI|
|Arithmetic expression was parsed|`UC-001`|Expression Evaluation Engine|
|Arithmetic expression was evaluated|`UC-001`|Expression Evaluation Engine|
|Numeric result was formatted|`UC-001`|Expression Evaluation Engine|
|Numeric result was displayed|`UC-001`|Calculator UI|
|Arithmetic expression evaluation failed|`UC-001`|Expression Evaluation Engine|
|ERROR was displayed|`UC-001`|Calculator UI|

### 8.3 정책
|정책|트리거 이벤트|결과|시스템|
|---|---|---|---|
|If the expression is syntactically valid|Arithmetic expression evaluation was requested|Parse the arithmetic expression|Expression Evaluation Engine|
|If the parsed expression is semantically evaluable|Arithmetic expression was parsed|Evaluate the parsed expression with operator precedence|Expression Evaluation Engine|
|If the numeric result needs decimal formatting|Arithmetic expression was evaluated|Format the numeric result to 10 decimal places|Expression Evaluation Engine|
|If the expression is syntactically invalid or incomplete|Arithmetic expression evaluation was requested|Display ERROR|Expression Evaluation Engine|
|If evaluation failed because of an invalid operation|Arithmetic expression evaluation failed|Display ERROR|Expression Evaluation Engine|

### 8.4 외부 시스템
|외부 시스템|관련 유스케이스|연동 목적|
|---|---|---|
|None|`UC-001`|None|

## 9. Canonical Summary/Index 반영
- 전체 `docs/design/이벤트 스토밍.md`에 summary/index 업데이트 필요 여부: No. The canonical summary/index file is not present.
- 반영할 링크/요약: None

## 10. 확인 필요
- None.
