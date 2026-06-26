## Output Template

`docs/plans/active/<WORK-ITEM-ID>/plan.md` must follow this compact structure. Keep entries terse. Prefer one-line bullets over tables unless a table prevents ambiguity.

~~~markdown
# 구현 계획

## 1. 구현 목표
- ChangeSet:
- Work item:
- 목표:

## 2. 구현하지 말아야 할 것
- ...

## 3. 입력 문서
- Slice:
- E2E/verification goal:
- 필수 입력:
- 누락/placeholder:

## 4. 아키텍처 제약
- 경계/의존성:
- 기술 결정:
- 도메인 영향:
- 충돌/호환성:
- OWASP Security Review: pending `security_plan_reviewer`; attack surface:

## 5. 구현 범위
- 포함:
- 제외:
- 위험/가정:

## 6. 구현 계획
- [ ] 필요 시 `spring-initializer` 실행.
- [ ] 필요 시 `spring-package-structure`로 구조/`ARCHITECTURE.md` 정합성 확인.
- [ ] ...

## 7. 테스트 계획
- [ ] 단위/도메인:
- [ ] 애플리케이션/어댑터:
- [ ] 호환성/E2E:

## 8. 검증 방법
- [ ] Build: `<command>` -> `<success criteria>`
- [ ] Tests: `<command>` -> `<success criteria>`
- [ ] E2E 또는 maintenance verification: `<command>` -> `<success criteria>`
- [ ] Test gate: `.codex/test-gate.yaml` required stage PASS
- [ ] Runtime server verification: `<harness run app 또는 N/A+사유>`
- [ ] Static analysis: `<command 또는 N/A+사유>`

## 9. 완료 조건
- 모든 체크박스가 `- [x]`.
- 필요한 테스트가 존재하고 통과.
- Build, Tests, E2E 또는 maintenance verification, Test gate, Runtime server verification, Static analysis 결과 기록.
- active -> completed 전이는 `complete-work-item-plan`만 수행.

## 10. 검증 결과
- Build: pending
- Tests: pending
- E2E 또는 maintenance verification: pending
- Test gate: pending
- Runtime server verification: pending
- Static analysis: pending
~~~

## User-Facing Result

After agent completion, report:

- Whether `ARCHITECTURE.md` existed.
- Whether static-analysis procedures were included in the work-item plan.
- The active plan path.
- Whether the plan is ready for executor use.
- Any missing ChangeSet, work-item, architecture, repository setting, technical decision, or canonical domain inputs.
