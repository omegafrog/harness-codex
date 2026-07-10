# <MAINT-ID>. <maintenance 작업 이름> Technical Decisions

## 1. 메타데이터

|항목|값|
|---|---|
|Maintenance ID|`<MAINT-ID>`|
|관련 ChangeSet|`docs/changes/active/<CHG-ID>.md`|
|Approval Status|approved or pending|
|승인 근거|사용자 확인 또는 승인된 maintenance 문서|

## 2. 입력

- ChangeSet: `docs/changes/active/<CHG-ID>.md`
- Change intent: `docs/maintenance/<MAINT-ID>/change-intent.md`
- Verification goal: `docs/maintenance/<MAINT-ID>/verification-goal.md`

## 3. 구현 영향 결정

|영역|결정|이유|구현 반영|테스트/검증 반영|상태|
|---|---|---|---|---|---|
|Code structure| | | | |pending|
|Compatibility| | | | |pending|
|Migration| | | | |pending|
|Observability| | | | |pending|
|Rollback| | | | |pending|

## 4. Repository 명령

|목적|명령|출처|
|---|---|---|
|Unit/Integration Test|`./venv/bin/python3 -m pytest -q -s`|repository default|
|Targeted Test| |`verification-goal.md`|

## 5. 미해결 결정

- 없음

## 6. Canonical 반영

- `docs/design/**` 업데이트 필요 여부:
- 충돌 여부:
