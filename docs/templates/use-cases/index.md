# <UC-ID>. <유스케이스 이름>

## 1. Slice 상태

|항목|값|
|---|---|
|UC ID|`<UC-ID>`|
|상태|draft / approved / planned / executing / completed / blocked|
|관련 ChangeSet|`docs/changes/active/<CHG-ID>.md`|
|E2E goal 승인|pending / approved|
|마지막 갱신일|YYYY-MM-DD|

## 2. 문서 목록

|문서|목적|상태|
|---|---|---|
|`use-case.md`|액터 목표와 흐름|draft|
|`event-storming.md`|UC 단위 command/event/policy/system slice|draft|
|`ddd-design.md`|UC 구현에 필요한 DDD 결정|draft|
|`technical-decisions.md`|UC 구현에 필요한 세부 기술 결정|draft|
|`e2e-goal.md`|완료 판정 기준과 검증 명령|draft|
|`affected-files.md`|예상 변경 파일과 금지 파일|draft|

## 3. Canonical 문서 추적

|Canonical 문서|참조 범위|충돌 여부|
|---|---|---|
|`docs/design/요구사항.md`| |none|
|`docs/design/유스케이스.md`| |none|
|`docs/design/이벤트 스토밍.md`| |none|
|`docs/design/details/index.md`| |none|
|`docs/design/기술결정.md`| |none|

## 4. 실행 상태

- Active plan: `docs/plans/active/<UC-ID>/plan.md`
- Verification: `docs/plans/active/<UC-ID>/verification.md`
- Completed plan: `docs/plans/completed/<UC-ID>/plan.md`

## 5. 확인 필요

- 없음
