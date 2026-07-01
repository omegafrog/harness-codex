# <UC-ID>. <유스케이스 이름> Affected Files

## 1. 입력

- ChangeSet: `docs/changes/active/<CHG-ID>.md`
- Use case: `docs/use-cases/<UC-ID>/use-case.md`
- E2E goal: `docs/use-cases/<UC-ID>/e2e-goal.md`

## 2. 예상 변경 파일

|경로|변경 유형|변경 이유|검증 방법|
|---|---|---|---|
|`src/...`|create/update/delete| | |

## 3. 예상 테스트 파일

|경로|테스트 대상|검증 규칙|
|---|---|---|
|`src/test/...`| | |

## 4. 문서 변경 파일

|경로|변경 이유|승인 필요 여부|
|---|---|---|
|`docs/use-cases/<UC-ID>/...`| |yes|

## 5. 금지 파일/경로

|경로|금지 이유|
|---|---|
|`docs/use-cases/<다른-UC-ID>/`|ChangeSet 범위 밖 유스케이스|
|`docs/design/**`|ChangeSet이 canonical 변경을 승인하지 않으면 금지|
|`ARCHITECTURE.md`|ChangeSet 또는 plan이 구조 변경을 승인하지 않으면 금지|
|`AGENTS.md`, `**/AGENTS.md`|read-only agent context|
|`.codex/**`, `.semgrep/**`, `.harness/**`, `.harness-codex/**`, `harness_codex/**`|harness/runtime/control-plane 경로|
|`.harness/docs/**`|harness 운영 문서와 템플릿, workflow 산출물 아님|
|`tests/runtime/**`, `completions/**`, `harness`, `scripts/install-harness-codex.sh`, `scripts/bump_runtime_version.py`|harness runtime 배포물|

## 6. Scope Boundary

### 포함

- 

### 제외

- 

## 7. 확인 필요

- 없음
