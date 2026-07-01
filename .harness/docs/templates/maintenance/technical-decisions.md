# <MAINT-ID>. <maintenance 작업 이름> Technical Decisions

## 1. 입력

- ChangeSet: `docs/changes/active/<CHG-ID>.md`
- Change intent: `docs/maintenance/<MAINT-ID>/change-intent.md`
- Verification goal: `docs/maintenance/<MAINT-ID>/verification-goal.md`

## 2. 구현 영향 결정

|영역|결정|이유|구현 반영|테스트/검증 반영|상태|
|---|---|---|---|---|---|
|Code structure| | | | |pending|
|Compatibility| | | | |pending|
|Migration| | | | |pending|
|Observability| | | | |pending|
|Rollback| | | | |pending|

## 3. Repository 명령

|목적|명령|출처|
|---|---|---|
|Unit/Integration Test|`./venv/bin/python3 -m pytest -q -s`|repository default|
|Targeted Test| |`verification-goal.md`|

## 4. 미해결 결정

- 없음

## 5. Canonical 반영

- `docs/design/**` 업데이트 필요 여부:
- 충돌 여부:
