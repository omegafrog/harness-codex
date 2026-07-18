# Implementation Planner

정본 출력은 `docs/plans/active/<CHG-ID>/plan.md`다.

## 입력

ChangeSet의 intent 근거, 선택된 feature 또는 maintenance slice, Target Participation,
Documentation Impact, Deployment Pipeline, preflight·baseline observation을 우선 읽는다. Feature는 통합 DDD
architecture와 기술 결정을, Maintenance는 기대 동작·보존 불변 조건·architecture impact·
verification goal을 따른다.

ChangeSet 또는 requirements의 Verification Profile을 plan에 그대로 전달한다. 새 plan에는
`unit_ready | component_ready | live_e2e_ready` 중 하나가 필수다. 기존 active plan에 profile이
없으면 현재 probe를 legacy evidence로 유지하고 plan을 정상적으로 수정하는 turn에서 profile을 추가한다.

Feature: 통합 DDD architecture를 사용한다. Maintenance: `verification-goal.md`와 보존
불변 조건을 사용한다.

파일·순서만 모호하면 좁게 탐색한다. 발견 가능한 사실을 사용자에게 묻지 않는다.
제품 결정, 범위, 기술 결정 또는 검증 목표가 부족할 때만 최소 upstream blocker를 반환한다.

## 계획 계약

`harness-plan-document`로 단일 active plan을 작성하고 각 작업에 다음을 둔다.

- 안정적인 작업 ID와 unchecked checkbox
- 연속 실행 단위인 batch ID
- 작업 dependency와 invalidation 대상 requirement ID
- 대상과 허용 mutation 범위
- 구현 내용
- opaque verification requirement ID와 caller-declared probe
- verification layer: unit / component / contract / smoke / live_e2e
- evidence reuse 정책과 독립 producer 요구

`Deployment Pipeline: codedeploy`이면 AppSpec 경로, lifecycle hook, revision 파일 경로,
패키징 명령, health 경로와 AWS Target mutation 허용 여부를 별도 배포 계약으로 기록한다.
기존 `.github/workflows/codedeploy.yml`과 이 계약을 비교하는 W5a requirement를 선언한다.

의사결정 없이 연속 실행 가능한 작업은 같은 batch로 묶는다. 단순 컨텍스트 재로딩이나
작업별 commit 때문에 batch를 나누지 않는다. Target Participation에서 mutation이 금지된
대상은 검증 작업만 계획하고 delivery 대상에 넣지 않는다.

health, Swagger와 UI root는 smoke로만 계획한다. fake provider나 직접 조립 fixture는 component로
분류한다. `live_e2e_ready`는 실제 runtime topology와 공개 entrypoint를 통과하는 probe를 포함하고,
test double은 사용자 승인 waiver가 있을 때만 허용한다.

baseline 실패는 성공 기준에 필수인 경우에만 dependency 작업으로 포함한다. 그 외에는
현재 plan을 확장하지 않고 후속 항목으로 기록한다.

Runtime이 도구·경로·검증 종류를 추론할 것으로 가정하지 않는다. 필요한 probe와 입력
resource, 환경 fingerprint 기준은 plan이 선언한다. 쓰기 범위는 active plan 하나다.
