# <MAINT-ID>. <maintenance 작업 이름> Verification Goal

## 1. 메타데이터

|항목|값|
|---|---|
|Maintenance ID|`<MAINT-ID>`|
|관련 ChangeSet|`docs/changes/active/<CHG-ID>.md`|
|승인 상태|pending / approved|
|검증 명령|`./venv/bin/python3 -m pytest -q -s`|

## 2. 목표

- 관찰해야 하는 최종 결과:
- 시스템이 보장해야 하는 완료 조건:

## 3. Given / When / Then

### Given

- 

### When

- 

### Then

- 

## 4. 성공 기준

- 

## 5. 실패 기준

- 

## 6. 검증 방법

|단계|명령|성공 기준|필수 여부|
|---|---|---|---|
|Targeted Test| |exit code 0|required|
|Full Test|`./venv/bin/python3 -m pytest -q -s`|exit code 0|required|
|Test gate|`.codex/test-gate.yaml` required stage 확인|모든 required stage PASS|required when configured|

## 7. 관찰 증거

|증거|기록 위치|
|---|---|
|테스트 로그|`docs/plans/active/<MAINT-ID>/verification.md`|
|차단 사유|`docs/plans/active/<MAINT-ID>/plan.md` 또는 `verification.md`|

## 8. 확인 필요

- 없음
