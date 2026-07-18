# 호출자 소유 워크플로우 선언 계약

이 문서는 오케스트레이션 계층의 정본이다. Runtime은 아래 필드의 의미를
해석하지 않고, 호출자가 제공한 schema·payload·resource digest와 증거만 검증한다.

## Intent Assessment

ChangeSet을 만들기 전에 다음 항목을 근거와 함께 확정한다.

| 항목 | 값 |
| --- | --- |
| 제품 의미·사업 정책·권한·상태 전이·공개 계약 변경 | yes / no / unknown |
| 승인된 기존 동작 복구 | yes / no / unknown |
| 승인 근거 | 문서·테스트·issue 또는 none |
| 보존할 외부 불변 조건 | 목록 또는 none |
| 운영·구성·테스트·문서·내부 구조만 변경 | yes / no / unknown |
| 미확정 제품 결정 | 목록 또는 none |

- `feature`: 첫 항목이 `yes`이고 긍정 근거가 있다.
- `bugfix`: 두 번째 항목이 `yes`이고 승인 근거가 있다.
- `refactor`: 첫 항목이 `no`, 마지막에서 두 번째 항목이 `yes`이며 외부 불변 조건을 보존한다.
- `unknown`이 남으면 탐색으로 확인한다. 탐색 후에도 남은 제품 결정만 사용자에게 묻는다.
- 사용자가 결과를 관찰할 수 있다는 사실, 새 파일, 새 실행 방법은 feature의 충분조건이 아니다.

## Target Participation

대상 위치나 저장소 종류를 역할로 추정하지 않고 대상마다 아래 행위를 선언한다.

| Target ID | Mutation | Verification | Delivery | Failure report | Blocking |
| --- | --- | --- | --- | --- | --- |
| opaque ID | allowed / forbidden | required / none | required / none | condition / never | yes / no |

- `Mutation: forbidden`인 대상은 읽기·검증만 한다.
- `Delivery: none`인 대상에는 bootstrap, 전달 Issue, 구현 handoff를 적용하지 않는다.
- 실패 보고 조건은 환경이 선언과 일치하고 대상 소유 실패가 관측된 뒤에만 충족된다.

## Documentation Impact

`none | local | broad | bootstrap` 중 하나를 선언한다.

- `none`: 문서 작업을 생략한다.
- `local`: 기존 국소 문서만 갱신한다. 문서 체계 생성·설치·전체 재작성은 금지한다.
- `broad`: 선언된 여러 기존 문서를 갱신하고 해당 검증만 수행한다.
- `bootstrap`: 사용자가 새 문서 체계를 요구했거나 제품 수준 결정으로 승인된 경우에만 허용한다.

## Deployment Pipeline

`none | codedeploy` 중 하나를 선언하며 기본값은 `none`이다.

- `none`: W5a를 `skipped`로 기록하고 기존 배포 workflow를 변경하지 않는다.
- `codedeploy`: W5가 확정한 AppSpec, hook, revision 패키징, health 계약과 기존 workflow를 비교한다.
- 계약과 workflow가 같으면 `unchanged`로 통과하고 파일을 다시 쓰지 않는다.
- 계약이 달라진 경우에만 하네스 생성 표식이 있는 workflow를 생성하거나 갱신한다.
- 사용자 소유 workflow는 보존하고 `conflict`로 보고한다.

## Verification Profile

ChangeSet마다 `unit_ready | component_ready | live_e2e_ready` 중 하나를 선언한다.

- `unit_ready`: build, domain/application unit, focused static contract를 검증한다.
- `component_ready`: unit 기준과 실제 local infrastructure 또는 승인된 test double을 사용하는
  service/component integration과 실행 계약을 검증한다.
- `live_e2e_ready`: 실제 runtime topology와 공개 entrypoint를 통한 사용자 여정을 검증한다.
  test double은 profile에 사용자가 승인한 waiver가 있을 때만 허용한다.

호출자는 요청과 위험에서 profile을 먼저 추론한다. 내부 변경·문서·저위험 refactor는
`unit_ready`, 공개 API/UI·실제 DB/service boundary 변경은 `component_ready`, runnable,
deploy, live journey 또는 실제 외부 경계 보장이 성공 기준이면 `live_e2e_ready`를 우선한다.
추론이 모호하거나 비용·환경 차이가 크면 사용자에게 질문한다.

profile은 required probe, 실행 환경, test double 정책, waiver와 함께 ChangeSet에서 plan,
verification, review로 전달한다. health·Swagger·UI root는 `smoke`, fake provider 기반 검증은
`component`이며 `live_e2e_ready` 증거로 승격하지 않는다.

기존 active ChangeSet에 profile이 없으면 기존 probe를 legacy evidence로 유지하고 다음 정상적인
plan 수정 시 profile을 기록한다. 새 ChangeSet과 새 plan에는 profile이 필수다.

## Preflight And Baseline

Mutation 전에 호출자가 opaque probe를 선언하고 Runtime의 generic probe utility로 실행한다.
각 probe는 ID, argv, 입력 resource digest, 환경 fingerprint, timeout, 기대 exit,
severity, waiver 허용 여부만 가진다. 도구와 경로 탐색은 오케스트레이터 책임이다.

같은 환경 fingerprint의 mutation 전·후 observation을 비교해 `unchanged`,
`regressed`, `improved`, `incomparable` 사실을 얻는다. 기존 실패는 현재 범위를
자동 확장하지 않으며 성공 기준에 필수인지 오케스트레이터가 별도로 판단한다.

## Execution And Evidence

Plan 작업은 `batch ID`, dependency, requirement ID, invalidation 관계를 가진다.
의사결정 없이 연속 실행 가능한 작업은 같은 batch에 둔다.

검증 증거는 Runtime의 `EvidenceEnvelope`를 사용한다. 계약·입력·환경·호출
fingerprint가 모두 같고 reuse가 허용될 때만 재사용한다. 독립 실행이 필요하면
requirement에 `reuse: forbid` 또는 독립 producer를 선언한다.

## Progress Events

진행 보고는 상태 전환, 새 실패, 사용자 판단, heartbeat, 최종 결과에만 발생한다.
동일 event key·revision·state·summary digest는 heartbeat 전까지 억제한다.

## Deferred Findings

active plan 범위 밖의 필요 기능·검증 공백은 자동 구현하지 않는다. 각 finding은 안정적인 ID,
근거, 범위 밖인 이유, 위험과 다음 disposition 중 하나를 가진다.

- `accepted_scope`: 사용자가 이번 범위 제외를 승인
- `follow_up_changeset`: 후속 ChangeSet 후보로 기록
- `github_issue`: 사용자 승인 뒤 Issue 생성 또는 재사용

미결정 finding이 있으면 W7은 `needs_input`이고 C1/C2로 진행하지 않는다. 모든 finding의
disposition이 확정되면 기존 `status: ready`를 사용하며 review와 PR에 achieved verification
level, finding disposition, Issue URL을 기록한다. GitHub Issue는 자동 생성하지 않는다.
