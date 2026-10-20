---
name: maintain-verification
description: Create or reconcile a project's user-facing verification map against source and real execution, distinguishing documentation drift, harness gaps, and product regressions.
---

# Maintain verification coverage

Use the existing project verification skill/map when available; otherwise seed `docs/verification/features.md` from affected user-facing commands/routes/use cases. Start with the main 3–5 journeys instead of cataloguing internals. The map is verification documentation, never a task board. For the Harness repository, the source-owned map lives at `docs/verification/features.md`; installed consumer projects discover their own surfaces rather than inheriting Harness CLI features.

Each feature records stable requirement/rule IDs when available, user entrypoint, prerequisites, owning Context/model/source, canonical drive command or recipe, observable result and side effects, evidence/cleanup rules, and last verified commit/result. Put launch/server/infra configuration in `docs/agents/EXEC.md` and link it; do not duplicate it in the map. Mark source-only recipes `not-run` until executed.

## Reconciliation

1. Read the index and affected source/tests/Spec IDs; detect missing, dead or duplicate journeys and mismatches. Use current code to establish facts, not to redefine expected business behavior.
2. Verify prerequisites and readiness before driving. Use the project's actual entrypoint; internal setters/test-only endpoints do not prove the user journey. Capture action plus observable result, exit code, errors and side effects. A help command only proves help, not install/eval behavior.
3. For full-stack/server/end-user execution, invoke the existing `e2e-test` skill and mandatory `e2e_test_runner` with the active absolute `workspace_root` and execution model. It owns process startup, health checks, evidence and cleanup. Keep the feature map as the scenario source and evidence outside cleanup scope. Do not create a parallel runner or enter `frontend-design` for this maintenance task.
4. After an unexpected failure, recheck health and return to a known state before another attempt. Clean only owned processes and scratch data after failures and at completion; verify evidence survives cleanup. Never kill by global process name or delete pre-existing artifacts.
5. Classify confirmed differences as map drift, verification-tool gap or product regression. Correct map/owned verification recipes only within scope; report product regressions to the existing tracker without rewriting expectations to match the bug. Map changes and tool fixes need re-execution of the affected journey before claiming verification.

Report each feature's source/live coverage, unreachable prerequisite, evidence, cleanup and `clean`, `changed` or `blocked` outcome. Report `partial` when requested scope covers only a subset; never imply whole-map coverage. If execution is unavailable, retain `not-run`/`blocked` and name the missing condition. No automatic PR, publication, commit or external message is authorized by this skill.

Origin: adapted from pstack [create-verification-skill](https://github.com/backnotprop/pstack/blob/6f131f137de64fdaf928278c0fd9ecec520ccbee/skills/create-verification-skill/SKILL.md) and [maintain-verification-skill](https://github.com/backnotprop/pstack/blob/6f131f137de64fdaf928278c0fd9ecec520ccbee/skills/maintain-verification-skill/SKILL.md), using Harness's existing E2E runner.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

## 세션 출력

`docs/agents/EXEC.md`의 세션 파일 출력 경계를 따른다. `harness-session-output.mjs --root <workspace_root>`로 절대 `session_directory`를 구하고 모든 agent/tool에 전달한다. 로그·임시 파일·스크린샷·실행 증거는 그 아래에만 저장한다. 각 process의 TMPDIR/TMP/TEMP와 browser output 경로도 지정한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로에 둔다.

## 테스트·서비스 실행 전제

테스트·서버·인프라 명령은 `docs/agents/EXEC.md`와 해당 프로젝트의 `docs/agents/execution.json`을 먼저 대조한 뒤 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile <id>`로만 실행한다. 필수 인자·환경값·설정 prepare/verify·인프라와 선행 서버 readiness가 실제 entrypoint와 일치해야 한다. 프로필 누락/실패 시 직접 명령으로 우회하지 않는다. caller가 프로필을 보완하고 runner는 설정을 추정·수정하지 않는다. 설정/의존성/시작 인자가 바뀐 구현은 프로필·EXEC도 함께 갱신한다. 결과에는 실행 profile·receipt·실제 준비/검증 실패를 포함한다.

## E2E 실패 재발 방지

E2E 전·후에는 [공통 실패 학습 절차](../e2e-test/references/failure-learning.md)를 적용한다. caller가 runner의 모든 실패를 `tests.e2e_failures`로 checkpoint/완료 state에 반영하고, 기존 실패 이력을 최신 성공 요약에서 제거하지 않는다. 현행 lesson·예방 검사와 실패별 수정/재검증 증거를 fresh-context handoff 및 다음 실행에 전달한다. 미해결 원인·외부 blocker·검증되지 않은 예방 조치는 완료를 막는다. runner는 증거 수집만 맡고 caller가 승인 범위 안에서 EXEC/profile·제품/검사 수정과 검증된 lesson 반영을 맡는다.
