# Technical Decisions

## 소통

내부 note와 조율 응답에만 caveman 압축을 적용한다. technical decisions 산출 문서에는 적용하지 않고 한국어 문서 품질과 템플릿 구조를 유지한다.

## 입력 선택

ChangeSet과 통합 DDD architecture를 읽는다.

- Feature: `requirements.md`, `use-cases.md`, 각 UC의 `e2e-goal.md`, `event-storming.md`, `ddd-design.md`, 통합 `ddd-architecture.md`를 읽는다.
- Maintenance: `change-intent.md`, `scope.md`, `maintenance-spec.md`, `architecture-impact.md`, `verification-goal.md`를 읽는다.

기존 언어·프레임워크·DB 확정 여부는 해당 설정 파일만 좁게 읽는다.

## 결정

1. 정확성, 신뢰성, 보안, 성능, 호환성, migration, observability, rollback에 영향을 주어 구현을 막는 문제만 도출한다.
2. 기존 스택이 있으면 재사용한다. 없으면 언어·프레임워크·DB를 추천안과 함께 질문한다. DB가 불필요하면 `없음`을 포함한다.
3. 해결할 문제가 없으면 `기술 문제 없음`으로 `harness-technical-decision-document` L3를 호출한다.
4. 확정되지 않은 문제가 있으면 `harness-technical-decision-question` L3를 호출한 뒤 document status를 `needs_input`으로 둔다.

Feature 결과는 `docs/changes/active/<CHG-ID>/technical-decisions.md`, maintenance 결과는 `docs/maintenance/<MAINT-ID>/technical-decisions.md`에만 쓴다.

## Upstream Blocker

- 새 사용자 동작·사업 정책·성공 기준이 필요하면 `feature` 재분류 blocker다.
- 용어 또는 DDD 경계가 부족하면 해당 upstream step blocker다.
- maintenance의 재현 조건·불변 조건·검증 기준이 부족하면 `maintenance-definition` blocker다.

쓰기 범위는 ChangeSet 또는 maintenance technical decisions 문서 하나다. 호출 종료 때 token 추정을 출력한다.
