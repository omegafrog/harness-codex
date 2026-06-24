## Output Template

`docs/plans/active/<WORK-ITEM-ID>/plan.md` must follow this structure:

~~~markdown
# Implementation Plan

## 1. 구현 목표
- ...

## 2. 구현하지 말아야 할 것
- ...

## 3. 입력 문서
|문서|사용 목적|상태|
|---|---|---|

## 3.1 ChangeSet 및 Work Item
- ChangeSet:
- Work item ID:
- Work item type:
- Work item slice:
- E2E/verification goal:

## 4. 아키텍처 제약
- ARCHITECTURE.md 기준:
- 모듈/패키지 경계:
- 의존성 방향:
- 금지 참조:

## 5. 구현 범위
- 포함:
- 제외:
- 가정:

## 5.1 승인된 기술 결정
|영역|결정|구현 반영|테스트/검증 반영|
|---|---|---|---|

## 5.2 도메인 영향
|type|id|mode|canonical path|plan impact|
|---|---|---|---|---|

## 5.3 호환성 확인
- 기존 유스케이스 영향:
- 같은 도메인 요소를 수정하는 active ChangeSet 충돌 여부:

## 5.4 OWASP Security Review
- Status: pending `security_plan_reviewer`
- Attack surface:
- Applicable standards:
- Exclusions and rationale:

## 6. 구현 계획
- [ ] 필요 시 `spring-initializer`를 사용해 Spring Boot 프로젝트 기준 설정 또는 신규 모듈을 초기화한다.
- [ ] `spring-package-structure`를 사용해 Spring 모듈/패키지 빈 구조와 `ARCHITECTURE.md`가 현재 설계와 일치하는지 생성 또는 검증한다.
- [ ] ...

## 7. 테스트 계획
- [ ] Domain/Aggregate/VO 테스트:
- [ ] Application Service 흐름 테스트:
- [ ] Infrastructure/Adapter 테스트:
- [ ] Communication/Transaction 테스트:
- [ ] Compatibility 테스트:

## 8. 검증 방법
- [ ] Build:
  - 명령: `./gradlew build`
  - 성공 기준:
- [ ] Tests:
  - 명령: `./gradlew test`
  - 성공 기준:
- [ ] E2E 또는 maintenance verification:
  - 명령:
  - 목표:
  - 성공 기준:
- [ ] Test gate:
  - 기준: `.codex/test-gate.yaml` required stage PASS
- [ ] Runtime server verification:
  - 서버 실행 명령:
  - 구현사항 확인 방법:
  - 성공 기준:
- [ ] Static analysis:
  - 절차:
  - 명령:
  - 성공 기준:

## 9. 완료 조건
- 모든 체크박스가 `- [x]` 상태다.
- 구현 범위의 테스트가 작성되어 통과했다.
- Build, Tests, E2E 또는 maintenance verification, Test gate, Runtime server verification, Static analysis가 성공했다.
- 검증 결과가 기록되어 있다.
- active → completed 전이는 workflow의 `complete-work-item-plan` git step이 수행한다.

## 10. 검증 결과
- Build:
- Tests:
- E2E 또는 maintenance verification:
- Test gate:
- Runtime server verification:
- Static analysis:

## 11. 검증 실패
- 없음
~~~

## User-Facing Result

After agent completion, report:

- Whether `ARCHITECTURE.md` existed.
- Whether static-analysis procedures were included in the work-item plan.
- The active plan path.
- Whether the plan is ready for executor use.
- Any missing ChangeSet, work-item, architecture, repository setting, technical decision, or canonical domain inputs.
