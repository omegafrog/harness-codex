# Maintenance Intake Rules

## 공통 산출물

maintenance template으로 다음 문서를 작성한다.

- `index.md`
- `change-intent.md`
- `scope.md`
- `maintenance-spec.md`
- `architecture-impact.md`
- `verification-goal.md`
- `links.md`

쓰기 범위는 위 공통 산출물 일곱 개다. `technical-decisions.md`는 구현을 막는 결정이 있을 때 후속 `harness-technical-decisions`가 작성한다.

## Bugfix

1. 승인된 기대 동작의 문서·테스트·issue 근거를 찾는다.
2. 재현 조건, 실제 결과, 기대 결과를 `maintenance-spec.md`에 기록한다.
3. 수정 전 실패하고 수정 후 통과할 regression verification을 `verification-goal.md`에 기록한다.
4. 기대 동작 근거가 없거나 새 정책이 필요하면 `feature` 재분류 blocker를 반환한다.

## Refactor

1. 보존할 외부 동작과 정책을 기존 테스트·계약에서 찾는다.
2. 현재 구조 문제, 목표 구조, 허용·금지 경로를 기록한다.
3. 동작 보존 검증과 필요한 구조 검증을 `verification-goal.md`에 기록한다.
4. 사용자 관찰 동작, 정책, 용어 또는 DDD 경계가 달라지면 해당 upstream blocker를 반환한다.

## Architecture와 기술 결정

- `architecture-impact.md`에는 BC, module/package, port/adapter, dependency direction과 canonical 문서 반영 필요 여부를 기록한다.
- architecture 영향이 `none`이고 미해결 구현 결정이 없으면 technical decisions를 `skipped`로 둔다.
- 언어·프레임워크·DB·호환성·migration·observability·rollback 결정이 구현을 막으면 `harness-technical-decisions`로 보낸다.

## 완료 Gate

- Before/After와 포함·제외 범위가 명시됐다.
- bugfix는 재현 조건과 기대 동작 근거가 있다.
- refactor는 보존할 불변 조건과 구조 목표가 있다.
- 허용·금지 경로와 영향 파일이 명시됐다.
- 실행 가능한 focused verification과 성공·실패 기준이 있다.
