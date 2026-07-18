# Plan Write Rules

쓰기 범위는 `docs/plans/active/<CHG-ID>/plan.md` 하나다. `template.md`를 따른다.

- 모든 구현 작업은 `- [ ]`로 시작하고 batch ID, dependency, Target과 Requirement ID를 가진다.
- 의사결정 없이 연속 실행 가능한 작업은 같은 batch로 묶는다.
- 각 Requirement에는 caller-owned probe, 입력 resource, 환경 fingerprint, dependency와 reuse 정책을 둔다.
- ChangeSet의 `Verification Profile`을 plan에 전파하고 각 probe를 `unit`, `smoke`, `component`,
  `live_e2e` 중 하나로 분류한다. fake/mock 기반 검증을 live E2E 증거로 승격하지 않는다.
- 같은 dependency·환경 fingerprint·관심사의 작업은 하나의 batch로 유지한다. task 또는 commit 경계만으로
  batch를 나누거나 executor 재생성을 요구하지 않는다.
- mutation 전 probe와 baseline observation을 `Preflight And Baseline`에 기록한다.
- Feature는 통합 DDD architecture의 BC·Aggregate·Application Service 흐름별 성공·실패 테스트를, maintenance는 기대 동작 또는 보존 불변 조건의 regression·구조 테스트를 포함한다.
- UI·DB·외부 의존성이 있으면 각각 UI 통합, 격리 test DB, mock/fake 검증을 포함한다.
- HTTP API 변경은 `/swagger-ui/index.html`, `/v3/api-docs` 구현·검증을 포함한다.
- 교차 BC 쓰기는 대상 경로에 명시한다.
- 외부 대상은 Target Participation에 행위별로 기록한다. `Mutation: forbidden` 또는
  `Delivery: none` 대상을 구현 전달에 포함하지 않는다.
- baseline 실패는 성공 기준에 필수인 경우에만 dependency 작업으로 포함한다.
- `Deployment Pipeline: codedeploy`이면 AppSpec, hook, revision 파일, 패키징 명령,
  health 경로와 W5a reconciliation requirement를 `Deployment Contract`에 기록한다.

모든 작업과 probe가 실행 가능할 때만 `status: ready`다. 허용되지 않은 mutation이나
미확정 제품 결정이 필요하면 `status: blocked`다.
