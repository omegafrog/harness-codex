# Implementation Planner

## 입력 선택

ChangeSet과 선택된 work item slice를 먼저 읽는다.

- UC: `use-case.md`, `e2e-goal.md`, `event-storming.md`, `ddd-design.md`, 통합 `ddd-architecture.md`가 있으면 함께 읽고 `technical-decisions.md`를 읽는다.
- Maintenance: `change-intent.md`, `scope.md`, `maintenance-spec.md`, `architecture-impact.md`, `verification-goal.md`, 존재하면 `technical-decisions.md`를 읽는다.

선택된 문서의 module·BC·허용 경로로 코드를 좁힌다. 경로가 확정되지 않을 때만 해당 범위에서 `rg`로 탐색한다.

## 계획

1. 파일 매핑·실행 순서만 모호하면 `harness-plan-question` L3를 호출한다.
2. domain·scope·technical·verification 입력이 부족하면 계획을 만들지 않고 최소 upstream blocker를 반환한다.
3. 확정된 계획은 `harness-plan-document` L3로 `docs/plans/active/<WORK-ITEM-ID>/plan.md`에 쓴다.
4. 각 작업에 안정적인 ID, unchecked checkbox, 대상 경로, 구현 내용, 실행 가능한 검증 명령을 둔다.
5. 검증 명령에 필요한 테스트 파일을 같은 작업의 대상 경로에 둔다. Python 명령은 `./venv/bin/python3`를 사용한다.

UC는 확정된 Entity·Value Object·Domain Service·Application Service와 성공·실패 정책을 작업과 테스트로 매핑한다. Maintenance는 기대 동작 또는 보존할 불변 조건, regression 또는 구조 검증을 작업과 테스트로 매핑하며 새 사업 정책이나 DDD 구조를 만들지 않는다.

UI는 UI → Application Service → Domain 흐름을 검증한다. DB는 격리된 실제 test DB integration을 계획한다. 외부 API·메시지·파일 저장소는 mock/fake 상호작용과 실패 처리를 계획한다. HTTP API 변경은 `/swagger-ui/index.html`, `/v3/api-docs` 실행 검증을 포함한다.

다른 BC 쓰기와 외부 repository 전달은 경로·범위·성공 기준을 명시한다. map에 없는 외부 repository나 허용되지 않은 교차 BC 쓰기가 필요하면 plan을 `blocked`로 둔다.

쓰기 범위는 선택된 active plan 하나다. 호출 종료 때 token 추정을 출력한다.
