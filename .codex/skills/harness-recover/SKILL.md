---
name: harness-recover
description: Diagnose and recover an installed project's blocked Harness installation, ticket synchronization, workflow records, or worktrees. Present a concrete repair plan and obtain user confirmation before changing project files, tickets, or execution state.
---

# Harness 복구

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)에 따라 `harness-static-call.mjs`가 스킬의 binding과 setup 설정을 읽어 model·effort를 선택한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

설치된 프로젝트에서 Harness를 실행·재개할 수 없는 원인을 진단하고 사용 가능한 상태로 복구한다. 일반 업데이트 요청은 `harness-maintenance`, 업무 구현은 해당 구현 스킬을 사용한다.

## 1. 읽기 전용 진단

1. 사용자에게 받은 오류와 재개하려는 작업을 확인한다. 각 명령의 `cwd`를 대상 프로젝트의 절대 경로로 지정하고 `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, `git worktree list --porcelain`로 원본 workspace와 실행 worktree를 구분한다. 경로가 불명확하면 대상부터 질문한다.
2. `GIT_OPTIONAL_LOCKS=0 git status --short --untracked-files=all`과 필요한 diff를 읽고 기존 변경을 분류한다. `.codex/harness-lock.json`, `.codex/harness.yaml`, 오류에 연결된 설치 파일·ticket·plan·Spec·실행 기록을 읽는다. 진단 결과는 대화에 제시한다. 파일 출력·백업 생성·task 생성 등 쓰기가 필요한 진단은 아래 확인 절차를 먼저 거친다.
3. 아래에서 증상에 해당하는 검사만 수행한다. 설치된 CLI가 없거나 손상됐으면 그 사실을 진단 근거로 남기고 사용 가능한 Git·파일·tracker 조회로 범위를 좁힌다. 외부 조회 실패는 권한·네트워크 실패와 실제 데이터 누락을 구분한다. 조회 CLI도 설치된 버전의 부수 효과를 확인해, session 생성·legacy migration·DB 초기화가 발생하면 승인 후 실행한다.

| 증상 | 읽을 근거와 검사 | 복구 시 참고할 절차 |
|---|---|---|
| 설치 누락·손상·버전/관리 파일 충돌 | lock의 inventory·hash·로컬 수정과 doctor 결과. `npx --yes --package github:omegafrog/harness-codex harness-codex-doctor --project <workspace_root>` | [harness-maintenance](../harness-maintenance/SKILL.md). lock이 없으면 설치 이력·백업으로 누락과 미설치를 구분한다. |
| workspace/preflight 실패 | 대상 worktree를 `cwd`로 `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` | 실제 Git root·등록 worktree·설정과 오류에 표시된 gate를 대조한다. |
| 준비 문서·실행 프로필·계약 문제 | `docs/agents/EXEC.md`, `docs/agents/execution.json`, `docs/contracts/`와 doctor의 readiness 상세. 계약은 `node .codex/scripts/harness-contracts.mjs check --root <workspace_root>` | [setup의 준비 복구](../setup/SKILL.md#설치업데이트-및-구현-전-준비-복구). 계약 수정이 필요할 때 [sync-contracts](../../../.codex/internal-skills/sync-contracts/GUIDE.md). |
| ticket 상태·mirror 불일치 | `node .codex/scripts/harness-tracker.mjs read --root <workspace_root> --ticket <ref>` 및 `check --root <workspace_root>`. 설정된 tracker의 실제 ticket·의존성과 Beads mirror를 대조한다. | [beads](../beads/SKILL.md). canonical 상태·mirror 상태·동기화 실패를 구분한다. |
| workflow 재개·완료 기록·review budget 문제 | 해당 `.codex/workflows/*.yaml`, 기존 session의 completion receipt·`runtime/plans/` journal/checkpoint·`runtime/reviews/` 기록과 현재 commit·Spec·plan·검증 증거 | 해당 공개 스킬의 재개 절차와 오류를 낸 CLI의 지원 복구 기능. journal의 권위 기록과 projection을 구분한다. |
| worktree 경로·소유권·정리 실패 | Git 등록 목록·branch·HEAD·변경 파일·실행 중 writer와 Git common directory 아래 기존 `harness-workflows/sessions/`의 `worktree.json`·legacy `receipt.json`을 직접 읽는다. | [session-worktree](../../../.codex/internal-skills/session-worktree/GUIDE.md), [worktree CLI](../../../.codex/internal-skills/session-worktree/references/worktree-cli.md). 소유권과 실제 실행 종료를 확인한다. `list`도 session 디렉터리 생성·legacy receipt migration을 할 수 있으므로 승인 후 호출한다. |
| 정리 후 준비 문서 손실·ignore 불일치 | Git 추적 여부·diff·기존 backup/recovery와 `git check-ignore -v <path>` | installer의 ignore 동기화. Harness 관리 산출물과 프로젝트 소유 문서를 경로별로 분류한다. |

정상적인 사용자 결정 대기·외부 의존성·실제 구현 결함·소진된 review budget은 필요한 결정과 재개 조건으로 보고한다. 복구 목표는 유효한 시작·재개 상태이며, 완료 상태는 실제 완료 증거와 gate 결과로 판정한다.

## 2. 변경안 제시와 사용자 확인

진단 뒤 다음 표를 대화에 작성하고 **구체적인 변경 범위에 대한 사용자 확인을 받은 뒤 실행한다**. “복구해”라는 최초 요청은 이 확인을 대신하지 않는다. 확인 전에는 읽기 전용 진단을 계속할 수 있다.

| 대상 | 현재 상태와 원인 근거 | 실행할 변경·명령과 기대 상태 | 보존·백업·복원 방법 | 재검사 |
|---|---|---|---|---|
| 정확한 파일 경로·ticket ref·worktree 경로/branch·기록 ID | 관찰한 오류와 충돌 | 생성·수정·삭제·상태 전환을 명시 | 기존 변경과 데이터의 보존 위치 및 복원 한계 | 원래 실패한 검사 |

확인 범위에는 관리 파일·설정·ignore·준비 문서·로그/백업 생성, 설치/update/force/lock, ticket/Issue/Beads 생성·삭제·수정·동기화, workflow/journal/receipt·review 기록 변경, worktree/branch 생성·이동·제거, process 종료와 Git 변경을 포함한다. 호출할 다른 스킬이나 CLI의 부수 변경도 같은 표에 포함한다. 새로운 변경 대상이나 작업이 발견되면 변경안을 갱신해 추가 확인을 받는다.

## 3. 승인된 복구 실행

1. 실행 직전 대상 경로·현재 Git/작업 상태·실행 중 writer를 다시 확인한다. 승인받은 상태와 달라졌으면 변경안을 갱신한다. 승인된 백업 위치에 영향받는 tracked 수정·untracked·필요한 ignored 파일과 상태 기록을 보존하고 읽을 수 있는지 확인한다.
2. 승인된 최소 복구를 기존 소유 CLI/절차로 실행한다. 설치/update는 공식 npx 경로를 사용하며, 로컬 충돌의 merge·force·lock은 승인된 선택을 적용한다. installer를 통해 관리 산출물 ignore를 동기화하고 `git check-ignore -v`로 확인한다. `docs/agents/EXEC.md`, `docs/agents/execution.json`, `docs/contracts/**` 등 프로젝트 소유 준비 문서는 Git에 보이도록 유지한다.
3. ticket 복구는 설정된 canonical tracker를 먼저 확인하고, v1 mirror는 공통 `harness-tracker.mjs sync`로 변경·재조회한다. 이미 반영된 canonical 변경 뒤 mirror만 실패했으면 현행 canonical을 기준으로 동기화를 재시도한다. ticket 삭제·재생성은 연결·의존성·이력 손실과 대체 ref까지 승인된 경우에 수행한다.
4. workflow 기록은 원래 오류의 원인을 고친 뒤 지원되는 재개·replay·복구 경로를 사용한다. 손상된 권위 기록에 지원 복구가 없으면 보존본과 재구성 근거를 제시해 별도 승인을 받는다. review budget 변경은 명시적 사용자 결정과 공통 resolve 절차를 적용하고, 검증·review·완료 결과는 실제 재실행 결과로 기록한다.
5. worktree 복구는 원본과 소유 실행 경로를 구분한다. 종료·제거는 실행 종료 확인과 recovery 보존·검증을 포함하는 소유 CLI 절차로 수행하고 branch/recovery를 보존한다. 살아 있는 실행·비소유 경로는 해당 소유자와 처리 범위를 먼저 확인한다. 정리 대상은 승인된 경로를 열거해 처리한다.
6. 일부 실행이 실패하면 실제 반영된 변경과 남은 오류를 확인한다. 승인된 복원 범위를 적용하고, 추가 조작이 필요하면 새 변경안을 제시한다.

## 4. 사용 가능 여부 검증

원래 실패했던 검사와 영향받은 doctor·preflight·tracker/worktree 검사를 다시 수행한다. 재검사 자체의 쓰기나 테스트/서비스 실행도 승인 범위에 포함한다. Git 상태와 backup/recovery를 확인하고 프로젝트 소유 변경이 보존됐는지 대조한다.

결과에는 원인, 승인·실행한 변경, 검사 결과, 남은 blocker, 정확한 workspace와 다음 재개 명령/스킬을 보고한다. 해결 근거가 부족하면 현재 상태와 필요한 결정을 보고한다. Harness 복구 완료와 업무 ticket/feature 완료를 각각 실제 기준으로 판정한다.
