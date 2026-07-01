# <MAINT-ID>. <maintenance 작업 이름>

## 1. Slice 상태

|항목|값|
|---|---|
|Maintenance ID|`<MAINT-ID>`|
|상태|draft / approved / planned / executing / completed / blocked|
|관련 ChangeSet|`docs/changes/active/<CHG-ID>.md`|
|Verification goal 승인|pending / approved|
|마지막 갱신일|YYYY-MM-DD|

## 2. 문서 목록

|문서|목적|상태|
|---|---|---|
|`change-intent.md`|변경 의도와 범위|draft|
|`technical-decisions.md`|필요한 구현 결정|draft / optional|
|`verification-goal.md`|완료 판정 기준과 검증 명령|draft|

## 3. 실행 상태

- Active plan: `docs/plans/active/<MAINT-ID>/plan.md`
- Verification: `docs/plans/active/<MAINT-ID>/verification.md`
- Completed plan: `docs/plans/completed/<MAINT-ID>/plan.md`

## 4. 확인 필요

- 없음
