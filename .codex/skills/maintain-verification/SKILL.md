---
name: maintain-verification
description: Create or reconcile a project's user-facing verification map against source and real execution, distinguishing documentation drift, harness gaps, and product regressions.
---

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [sync-contracts](../../../.codex/internal-skills/sync-contracts/GUIDE.md).

# Maintain verification coverage

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

Use the existing project verification skill/map when available; otherwise seed `docs/verification/features.md` from affected user-facing commands/routes/use cases. Start with the main 3–5 journeys instead of cataloguing internals. The map is verification documentation, never a task board. For the Harness repository, the source-owned map lives at `docs/verification/features.md`; installed consumer projects discover their own surfaces rather than inheriting Harness CLI features.

Each feature records stable requirement/rule IDs when available, user entrypoint, prerequisites, owning Context/model/source, canonical drive command or recipe, observable result and side effects, evidence/cleanup rules, and last verified commit/result. Read the [shared verification policy](../e2e-test/references/verification-policy.md): prefer focused lower-level checks; use E2E only when explicitly requested or justified by a changed critical cross-boundary risk that cheaper checks cannot establish. Put launch/server/infra configuration in `docs/agents/EXEC.md` and link it; do not duplicate it in the map. Mark source-only recipes `not-run` until executed.

## Reconciliation

1. Read the index and affected source/tests/Spec IDs; detect missing, dead or duplicate journeys and mismatches. Use current code to establish facts, not to redefine expected business behavior.
2. Verify prerequisites and readiness before driving. Use the project's actual entrypoint; internal setters/test-only endpoints do not prove the user journey. Capture action plus observable result, exit code, errors and side effects. A help command only proves help, not install/eval behavior.
3. When the shared policy and approved plan require E2E, invoke the existing `e2e-test` skill and `e2e_test_runner` with the active absolute `workspace_root` and execution model. It owns process startup, health checks, evidence and cleanup. Keep the feature map as the scenario source and evidence outside cleanup scope. Do not create a parallel runner or enter `frontend-design` for this maintenance task.
4. After an unexpected failure, recheck health and return to a known state before another attempt. Clean only owned processes and scratch data after failures and at completion; verify evidence survives cleanup. Never kill by global process name or delete pre-existing artifacts. Share the policy's bounded attempt budget across handoffs.
5. Classify confirmed differences as map drift, verification-tool gap or product regression. Correct map/owned verification recipes only within scope; report product regressions to the existing tracker without rewriting expectations to match the bug. Map changes need a focused check of the map. Tool fixes need re-execution of an affected journey only when required by the shared policy; do not run unrelated E2E to verify lower-level changes.

Report each feature's source/live coverage, unreachable prerequisite, evidence, cleanup and `clean`, `changed` or `blocked` outcome. Report `partial` when requested scope covers only a subset; never imply whole-map coverage. If execution is unavailable, retain `not-run`/`blocked` and name the missing condition. No automatic PR, publication, commit or external message is authorized by this skill.

Origin: adapted from pstack [create-verification-skill](https://github.com/backnotprop/pstack/blob/6f131f137de64fdaf928278c0fd9ecec520ccbee/skills/create-verification-skill/SKILL.md) and [maintain-verification-skill](https://github.com/backnotprop/pstack/blob/6f131f137de64fdaf928278c0fd9ecec520ccbee/skills/maintain-verification-skill/SKILL.md), using Harness's existing E2E runner.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

## 세션 출력

`docs/agents/EXEC.md`의 세션 파일 출력 경계를 따른다. `harness-session-output.mjs --root <workspace_root>`로 절대 `session_directory`를 구하고 모든 agent/tool에 전달한다. 로그·임시 파일·스크린샷·실행 증거는 그 아래에만 저장한다. 각 process의 TMPDIR/TMP/TEMP와 browser output 경로도 지정한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로에 둔다.

## 테스트·서비스 실행 전제

일반 단위·회귀 검증은 프로젝트 `docs/agents/EXEC.md`의 명령을 해당 언어의 기본 CLI로 실행한다. `harness-exec`와 `execution.json`은 명시적 사용자 흐름 E2E에만 사용하며, 그 외 profile을 만들거나 runner로 감싸지 않는다. 실제 E2E에서는 실행 인자·필수 환경·설정 검사와 dependency readiness를 확인하고 receipt를 보고한다.

## E2E 실패 재발 방지

E2E 전·후에는 [공통 실패 학습 절차](../e2e-test/references/failure-learning.md)를 적용한다. caller가 runner의 모든 실패를 `tests.e2e_failures`로 checkpoint/완료 state에 반영하고, 기존 실패 이력을 최신 성공 요약에서 제거하지 않는다. 현행 lesson·예방 검사와 실패별 수정/재검증 증거를 fresh-context handoff 및 다음 실행에 전달한다. 현재 필수 테스트의 실패·미실행과 실제 미해결 blocker는 완료를 막는다. 과거 실패의 학습 분류·지침 갱신·예방 조치 검증 상태는 별도 pending으로 인계하며 테스트 결과나 완료 판정을 바꾸지 않는다. runner는 증거 수집만 맡고 caller가 승인 범위 안에서 EXEC/profile·제품/검사 수정과 검증된 lesson 반영을 맡는다.
