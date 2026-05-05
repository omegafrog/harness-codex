# <UC-ID>. <유스케이스 이름> E2E Goal

## 1. 메타데이터

|항목|값|
|---|---|
|UC ID|`<UC-ID>`|
|관련 ChangeSet|`docs/changes/active/<CHG-ID>.md`|
|승인 상태|pending / approved|
|검증 명령|`./gradlew e2eTest`|

## 2. 목표

- 사용자가 관찰해야 하는 최종 결과:
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
|Build|`./gradlew build`|exit code 0|required|
|Unit/Integration Test|`./gradlew test`|exit code 0|required|
|E2E Test|`./gradlew e2eTest`|이 문서의 Given/When/Then 충족|required when E2E exists|
|Test gate|`.codex/test-gate.yaml` required stage 확인|모든 required stage PASS|required|

## 7. 관찰 증거

|증거|기록 위치|
|---|---|
|테스트 로그|`docs/plans/active/<UC-ID>/verification.md`|
|서버/API/UI 관찰 결과|`docs/plans/active/<UC-ID>/verification.md`|
|차단 사유|`docs/plans/active/<UC-ID>/plan.md` 또는 `verification.md`|

## 8. 확인 필요

- 없음
