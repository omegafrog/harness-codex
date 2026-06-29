## Output Template

`docs/plans/active/<WORK-ITEM-ID>/plan.md` must follow this executor-complete structure. Keep entries terse, but do not replace required decisions with placeholders. Use `N/A - <reason>` only when a required section is genuinely inapplicable.

~~~markdown
# 구현 계획

## 1. 구현 목표
- ChangeSet:
- Work item:
- 목표:

## 2. 구현하지 말아야 할 것
- ...

## 실행 경계
- 대상 bounded context/module:
- 대상 aggregate root:
### 수정 허용 경로
### 수정 금지 경로
### 영향받는 기존 파일

## 패키지 및 의존성 계약
### 생성/수정 클래스와 정확한 package
### 각 클래스의 layer와 책임
### 허용 의존성 방향
### 금지 import/framework dependency
### bootstrap/configuration wiring

## 도메인 구현 계약
### Aggregate invariant
### 상태 전이
### Entity/Value Object 생성 및 검증 규칙
### Domain Service 여부와 책임
### Domain Event 및 persistence compatibility
### 다른 Aggregate/Bounded Context 협력 방식
### Transaction, idempotency, concurrency

## 외부 계약 읽기 허용 목록
- `<reason>` -> `<exact path or pattern>`
- N/A - 외부 계약 read가 필요 없으면 이유를 기록.

## 작업 체크리스트
- [ ] TASK-001 `<exact file>`: 구현 책임과 만족해야 할 도메인 규칙.
- [ ] TEST-001 `<exact test file>`: 검증할 invariant/state transition/orchestration.
- [ ] TASK-002 `<adapter/config file>`: 필요한 Port/Adapter 또는 설정 작업.

## 집중 검증
- [ ] VERIFY-001 Build: `<command>` -> `<success criteria>`
- [ ] VERIFY-002 Focused tests: `<command>` -> `<success criteria>`
- [ ] VERIFY-003 Architecture test: `<command 또는 N/A+사유>`
- [ ] VERIFY-004 E2E 또는 maintenance verification: `<command>` -> `<success criteria>`
- [ ] VERIFY-005 Test gate: `.codex/test-gate.yaml` required stage PASS
- [ ] VERIFY-006 Runtime server verification: `<harness run app 또는 N/A+사유>`
- [ ] VERIFY-007 Static analysis: `<command 또는 N/A+사유>`
### 중단 조건

## 9. OWASP Security Review
- pending `security_plan_reviewer`; attack surface:

## 10. 완료 조건
- 모든 체크박스가 `- [x]`.
- 필요한 테스트가 존재하고 통과.
- Build, focused tests, architecture test, E2E 또는 maintenance verification, Test gate, Runtime server verification, Static analysis 결과 기록.
- active -> completed 전이는 `complete-work-item-plan`만 수행.

## 11. 검증 결과
- Build: pending
- Focused tests: pending
- Architecture test: pending
- E2E 또는 maintenance verification: pending
- Test gate: pending
- Runtime server verification: pending
- Static analysis: pending
~~~

## User-Facing Result

After agent completion, report:

- Whether the executor-complete plan contract was satisfied.
- The active plan path.
- Whether the plan is ready for executor use.
- Any missing ChangeSet, work-item, architecture, repository setting, technical decision, canonical domain input, package decision, or domain decision.
