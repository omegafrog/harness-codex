# ChangeSet <CHG-ID>

## 1. 메타데이터

|항목|값|
|---|---|
|ChangeSet ID|`<CHG-ID>`|
|상태|active|
|작성일|YYYY-MM-DD|
|작성자|Codex|
|관련 이슈/요청|<URL 또는 설명>|

## 2. 구현 의도

- 요청 요약:
- 사용자가 얻어야 하는 결과:
- 변경이 필요한 이유:

### Intent Assessment

|판단|값|근거|
|---|---|---|
|제품 의미·사업 정책·권한·상태 전이·공개 계약 변경|yes/no/unknown| |
|승인된 기존 동작 복구|yes/no/unknown| |
|운영·구성·테스트·문서·내부 구조만 변경|yes/no/unknown| |
|보존할 외부 불변 조건|목록/none| |
|미확정 제품 결정|목록/none| |

## 3. Before / After

|구분|내용|
|---|---|
|Before|현재 동작, 문서 상태, 또는 구조|
|After|변경 후 기대 동작, 문서 상태, 또는 구조|

## 4. 변경 문서

|문서|변경 유형|변경 이유|상태|
|---|---|---|---|
|`docs/...`|create/update/move/delete| |planned|

## 5. 영향 Work Item

|Work Item ID|유형|이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`UC-001`|use_case| |new/update/none|`docs/use-cases/UC-001/`|planned|
|`MAINT-001`|maintenance| |new/update/none|`docs/maintenance/MAINT-001/`|planned|

## 6. 검증 목표 변경

|Work Item ID|검증 목표 경로|변경 여부|승인 상태|비고|
|---|---|---|---|---|
|`UC-001`|`docs/use-cases/UC-001/e2e-goal.md`|new/update/none|pending| |
|`MAINT-001`|`docs/maintenance/MAINT-001/verification-goal.md`|new/update/none|pending| |

## 7. Planner 입력 범위

planner는 아래 문서만 우선 입력으로 사용한다.

- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/ddd-design.md` when present
- `docs/use-cases/<UC-ID>/technical-decisions.md` when present
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- `docs/maintenance/<MAINT-ID>/change-intent.md`
- `docs/maintenance/<MAINT-ID>/technical-decisions.md` when present
- `docs/maintenance/<MAINT-ID>/verification-goal.md`
- `ARCHITECTURE.md`
- `docs/design/기술결정.md`
- `.codex/repository-settings.md`

## 8. Scope Boundary

### 포함

- 

### 제외

- 

### 금지 변경

- ChangeSet에 없는 유스케이스 문서 임의 수정 금지
- 승인되지 않은 E2E goal 변경 금지
- 승인되지 않은 `docs/design/**` canonical 문서 변경 금지
- 명시되지 않은 코드/테스트/설정 변경 금지

## 8a. Target Participation

|Target ID|Mutation|Verification|Delivery|Failure report|Blocking|
|---|---|---|---|---|---|
| |allowed/forbidden|required/none|required/none|condition/never|yes/no|

## 8b. Documentation Impact

- 수준: `none | local | broad | bootstrap`
- 근거:

## 8c. Deployment Pipeline

- 값: `none | codedeploy`
- 근거:

## 8d. Verification Profile

- Required level: `unit_ready | component_ready | live_e2e_ready`
- 추론 근거:
- Required environment:
- Test double: `allowed | forbidden | waived`
- Waiver: `none | 사용자 승인과 근거`

## 8e. Deferred Findings

|Finding ID|내용|범위 밖 근거|위험|Disposition|사용자 승인|URL|
|---|---|---|---|---|---|---|

## 9. 상위 설계 영향

|영역|영향 여부|설명|재검토 필요 여부|
|---|---|---|---|
|Requirements|none/changed| |no|
|Use cases|none/changed| |no|
|Event storming|none/changed| |no|
|DDD design|none/changed| |no|
|Technical decisions|none/changed| |no|
|Architecture|none/changed| |no|

## 10. 완료 조건

- 영향받은 모든 UC slice가 존재한다.
- 영향받은 모든 UC의 E2E goal이 승인되었다.
- 영향받은 모든 maintenance slice가 존재한다.
- 영향받은 모든 maintenance verification goal이 승인되었다.
- 영향받은 모든 `docs/plans/active/<UC-ID>/plan.md`가 완료되어
  `docs/plans/completed/<UC-ID>/plan.md`로 이동했다.
- 영향받은 모든 `docs/plans/active/<MAINT-ID>/plan.md`가 완료되어
  `docs/plans/completed/<MAINT-ID>/plan.md`로 이동했다.
- 각 work item에 선언된 focused verification evidence가 PASS로 기록되었다.
- 이 ChangeSet이 `docs/changes/completed/<CHG-ID>.md`로 이동했다.

## 11. 검증 기록

|명령/검증|결과|증거|
|---|---|---|
| | | |

## 12. 차단/충돌

- 없음
