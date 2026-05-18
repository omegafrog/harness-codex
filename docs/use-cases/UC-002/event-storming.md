# UC-002. End User Edits the Current Expression 이벤트 스토밍

## 1. 개요
- 입력 ChangeSet: docs/changes/active/CHG-20260507-001.md
- 입력 유스케이스: docs/use-cases/UC-002/use-case.md
- 입력 E2E 목표: docs/use-cases/UC-002/e2e-goal.md
- Canonical summary/index: docs/design/이벤트 스토밍.md
- 산출물 목적: affected UC를 초기 커맨드로 삼아 해당 UC 구현에 필요한 이벤트, 정책, 커맨드, 시스템, 외부 시스템, 규칙을 추출한다.

## 2. 범례
|유형|의미|작성 규칙|
|---|---|---|
|🟦 커맨드|시스템에게 어떤 행위를 수행하라고 내리는 명령|명령형으로 작성|
|🟧 이벤트|도메인 안에서 발생한 사실|과거형으로 작성|
|🟪 정책|이벤트 발생 후 다음 행동을 결정하는 규칙|조건과 결정을 함께 작성|
|⬛ 시스템|커맨드, 이벤트, 정책의 소유 주체|도메인/시스템 이름으로 작성|
|🟩 외부 시스템|도메인 외부의 협력 시스템|외부 시스템 이름으로 작성|

## 3. 시작 유스케이스
- 유스케이스: UC-002. End User Edits the Current Expression
- 액터: End user
- 목표: End user edits the current expression before the next calculation.
- 초기 커맨드: 🟦 Update the current expression

### 사전 조건
- The calculator page loaded successfully.
- The current page session is active in a supported desktop browser.

### 종료 조건
- 성공: The system shows the updated current expression and clears any previously shown result when the expression changes.
- 실패: The system keeps invalid or incomplete intermediate expression text as entered and does not auto-correct it.

## 4. 흐름
### [Flow: 기본 흐름]
🟦 Update the current expression
→ 🟧 Current expression update was requested
→ 🟪 If the edit input is accepted as a direct expression change, update the in-memory expression state immediately
→ 🟧 Current expression was updated
→ 🟪 If a previous result is visible after the expression update, clear the stale result immediately
→ 🟧 Previous result was cleared
→ 🟪 If the updated expression state exists after stale-result handling, render the current expression immediately
→ 🟧 Updated current expression was displayed

---
### [Flow: 예외 흐름]
🟦 Delete a single character from the current expression
→ 🟧 Single-character delete was requested
→ 🟪 If the current expression has at least one character, remove only the last editable character from the current expression
→ 🟧 Single character was removed from the current expression
→ 🟪 If a previous result is visible after the expression change, clear the stale result immediately
→ 🟧 Previous result was cleared
→ 🟪 If the updated expression state exists after stale-result handling, render the current expression immediately
→ 🟧 Updated current expression was displayed

---
### [Flow: 예외 흐름]
🟦 Update the current expression
→ 🟧 Invalid or incomplete expression text was entered
→ 🟪 If the edited text is invalid or incomplete during editing, keep the text exactly as entered and do not auto-correct it
→ 🟧 Invalid or incomplete expression text was preserved
→ 🟪 If a previous result is visible after the expression change, clear the stale result immediately
→ 🟧 Previous result was cleared
→ 🟪 If the updated expression state exists after stale-result handling, render the current expression immediately
→ 🟧 Updated current expression was displayed

---
### [Flow: 예외 흐름]
🟦 Update the current expression
→ 🟧 Current expression update was requested
→ 🟪 If no previous result is visible after the expression update, render the current expression immediately
→ 🟧 Updated current expression was displayed

---
## 5. 도메인 요소 (통합)
|유형|내용|트리거|결과|시스템|비고|
|---|---|---|---|---|---|
|🟦|Update the current expression|End user keyboard input or on-screen button input|Current expression update was requested|Calculator Input System|Initial command for UC-002|
|🟦|Delete a single character from the current expression|End user delete or backspace action|Single-character delete was requested|Calculator Input System|Covers keyboard delete and backspace behavior|
|🟦|Clear the previous result|Policy after expression change|Previous result was cleared|Calculator State System|Triggered only when a stale result is visible|
|🟦|Render the current expression|Policy after state update|Updated current expression was displayed|Calculator View System|Immediate UI reflection|
|🟦|Keep the edited expression text|Policy after invalid or incomplete edit input|Invalid or incomplete expression text was preserved|Calculator State System|No auto-correction path|
|🟧|Current expression update was requested|Update the current expression|If the edit input is accepted as a direct expression change, update the in-memory expression state immediately|Calculator Input System|Represents user edit intent|
|🟧|Current expression was updated|Policy after current expression update request|If a previous result is visible after the expression update, clear the stale result immediately|Calculator State System|In-memory page-session state only|
|🟧|Previous result was cleared|Clear the previous result|If the updated expression state exists after stale-result handling, render the current expression immediately|Calculator State System|Prevents stale result display|
|🟧|Updated current expression was displayed|Render the current expression|None|Calculator View System|User-visible outcome|
|🟧|Single-character delete was requested|Delete a single character from the current expression|If the current expression has at least one character, remove only the last editable character from the current expression|Calculator Input System|Single-character removal intent|
|🟧|Single character was removed from the current expression|Policy after single-character delete request|If a previous result is visible after the expression change, clear the stale result immediately|Calculator State System|Delete/backspace effect|
|🟧|Invalid or incomplete expression text was entered|End user keyboard input or on-screen button input|If the edited text is invalid or incomplete during editing, keep the text exactly as entered and do not auto-correct it|Calculator Input System|Exception-flow trigger|
|🟧|Invalid or incomplete expression text was preserved|Keep the edited expression text|If a previous result is visible after the expression change, clear the stale result immediately|Calculator State System|Editing keeps raw intermediate text|
|🟪|If the edit input is accepted as a direct expression change, update the in-memory expression state immediately|Current expression update was requested|Current expression was updated|Calculator State System|Immediate update requirement|
|🟪|If a previous result is visible after the expression update, clear the stale result immediately|Current expression was updated|Clear the previous result|Calculator State System|Stale-result clearing rule|
|🟪|If the updated expression state exists after stale-result handling, render the current expression immediately|Previous result was cleared|Render the current expression|Calculator View System|Keeps UI synchronized after result clearing|
|🟪|If no previous result is visible after the expression update, render the current expression immediately|Current expression update was requested|Render the current expression|Calculator View System|Direct render path without stale-result clearing|
|🟪|If the current expression has at least one character, remove only the last editable character from the current expression|Single-character delete was requested|Single character was removed from the current expression|Calculator State System|Single-meaning deletion rule|
|🟪|If a previous result is visible after the expression change, clear the stale result immediately|Single character was removed from the current expression|Clear the previous result|Calculator State System|Delete path shares stale-result rule|
|🟪|If the edited text is invalid or incomplete during editing, keep the text exactly as entered and do not auto-correct it|Invalid or incomplete expression text was entered|Keep the edited expression text|Calculator State System|Exception-flow preservation rule|
|🟪|If a previous result is visible after the expression change, clear the stale result immediately|Invalid or incomplete expression text was preserved|Clear the previous result|Calculator State System|Invalid-edit path still clears stale result|

---
## 6. 외부 시스템
|시스템|연동 목적|관련 유스케이스|비고|
|---|---|---|---|
|없음|없음|UC-002|없음|

---
## 7. 규칙 (Invariant)
- The current expression state must update immediately in browser memory during the active page session.
- Any previously shown result must not remain visible after the current expression changes.
- Invalid or incomplete intermediate expression text must be preserved exactly as entered during editing.
- Expression editing must remain frontend-only and must not call backend or third-party systems.

## 8. UC 도메인 요소 요약
### 8.1 커맨드
|커맨드|출처 유스케이스|시스템|
|---|---|---|
|Update the current expression|UC-002|Calculator Input System|
|Delete a single character from the current expression|UC-002|Calculator Input System|
|Clear the previous result|UC-002|Calculator State System|
|Render the current expression|UC-002|Calculator View System|
|Keep the edited expression text|UC-002|Calculator State System|

### 8.2 이벤트
|이벤트|출처 유스케이스|시스템|
|---|---|---|
|Current expression update was requested|UC-002|Calculator Input System|
|Current expression was updated|UC-002|Calculator State System|
|Previous result was cleared|UC-002|Calculator State System|
|Updated current expression was displayed|UC-002|Calculator View System|
|Single-character delete was requested|UC-002|Calculator Input System|
|Single character was removed from the current expression|UC-002|Calculator State System|
|Invalid or incomplete expression text was entered|UC-002|Calculator Input System|
|Invalid or incomplete expression text was preserved|UC-002|Calculator State System|

### 8.3 정책
|정책|트리거 이벤트|결과|시스템|
|---|---|---|---|
|If the edit input is accepted as a direct expression change, update the in-memory expression state immediately|Current expression update was requested|Current expression was updated|Calculator State System|
|If a previous result is visible after the expression update, clear the stale result immediately|Current expression was updated|Clear the previous result|Calculator State System|
|If the updated expression state exists after stale-result handling, render the current expression immediately|Previous result was cleared|Render the current expression|Calculator View System|
|If no previous result is visible after the expression update, render the current expression immediately|Current expression update was requested|Render the current expression|Calculator View System|
|If the current expression has at least one character, remove only the last editable character from the current expression|Single-character delete was requested|Single character was removed from the current expression|Calculator State System|
|If a previous result is visible after the expression change, clear the stale result immediately|Single character was removed from the current expression|Clear the previous result|Calculator State System|
|If the edited text is invalid or incomplete during editing, keep the text exactly as entered and do not auto-correct it|Invalid or incomplete expression text was entered|Keep the edited expression text|Calculator State System|
|If a previous result is visible after the expression change, clear the stale result immediately|Invalid or incomplete expression text was preserved|Clear the previous result|Calculator State System|

### 8.4 외부 시스템
|외부 시스템|관련 유스케이스|연동 목적|
|---|---|---|
|없음|UC-002|없음|

## 9. Canonical Summary/Index 반영
- 전체 `docs/design/이벤트 스토밍.md`에 summary/index 업데이트 필요 여부: No, because the canonical summary/index file is absent in the allowed context.
- 반영할 링크/요약: None.

## 10. 확인 필요
- None from the active ChangeSet and the affected UC-002 slice at this event-storming gate.
