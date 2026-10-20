---
name: e2e-test
description: Run full-stack end-user E2E tests in the active worktree, following repository execution instructions and cleaning test artifacts afterward.
---

# E2E 테스트 실행

실제 애플리케이션과 필요한 인프라를 띄우고 사용자 관점으로 검증해야 할 때 사용한다. 호출자는 활성 worktree의 절대 `workspace_root`와 세션을 시작한 원본 프로젝트의 절대 `shared_guidance_root`(`return_root`)를 모두 확정하고, 두 경로가 같은 Git common directory인지 확인한다. `<shared_guidance_root>/docs/agents/testing-guidance.md`를 먼저 읽는다. `.codex/harness.yaml`의 `agents.execution_model`, `agents.execution_reasoning_effort`를 해석한 뒤 `multi_agent_v1.spawn_agent`로 `agent_type="e2e_test_runner"`를 호출한다. `workspace_root`와 `cwd`에 동일한 경로를 지정하고 두 경로, 사용자 시나리오·성공 조건·timeout을 전달하며 해석한 model/reasoning 값을 명시한다. 값이 없거나 실행기가 활성 worktree 경로에서 명령을 실행할 수 없으면 테스트하지 않고 blocker로 보고한다.

프로젝트의 검증 기능 지도(있으면 `docs/verification/features.md`)에서 관련 시나리오·requirement/rule ID·진입점·성공 결과를 읽는다. 기능 변경으로 지도가 달라지면 검증한 항목만 갱신한다. 지도의 생성·전체 정합성 점검은 `maintain-verification`을 사용하며, 여기서는 요청된 범위의 실제 실행만 맡는다. 성능 목표가 있으면 plan의 workload·baseline·지표와 measurement 증거 계약을 따른다.

## 실패 학습과 다음 실행

caller와 runner는 [실패 재발 방지](references/failure-learning.md)를 읽는다. 실행 전 프로젝트의 현행 `docs/verification/e2e-lessons.md`와 예방 검사를 확인하고, 실패 후에는 caller가 원인 확인→실제 예방 조치→해당 경로 재검증→lesson 반영을 소유한다. runner는 시도별 증거와 `tests.e2e_failures` 입력을 반환하며 수정/학습 완료를 추정하지 않는다. 미해결 실패를 단순 재시도 성공으로 지우지 않는다.

## 실행 절차

1. 현재 디렉터리와 `git rev-parse --show-toplevel`을 확인해 활성 워크트리 경로를 확정한다. 호출 세션에서 전달된 워크트리와 다르면 실행하지 않고 불일치를 보고한다. 이후 모든 명령의 working directory는 이 경로로 고정한다. 인프라를 시작하기 전에 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <worktree> --json`을 실행하고 `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다. 실패하면 서버나 테스트를 시작하지 않는다.
2. `<shared_guidance_root>/docs/agents/testing-guidance.md`, 활성 worktree의 `docs/agents/EXEC.md`, E2E 대상의 실행 지침을 읽는다. 서버·인프라 준비, 환경 변수, 실행·대기·종료 명령은 활성 worktree의 프로젝트 계약을 따른다. 필요한 명령이나 전제가 없으면 추측해 환경을 변경하지 말고 blocker로 보고한다.
3. `.codex/skills/e2e-test/scripts/artifact-guard.mjs snapshot --root <worktree> --manifest <session_directory>/runtime/e2e/<run_id>/artifacts.json`을 실행해 기존 untracked/ignored 경로를 기록한다. manifest는 공통 resolver로 구한 세션 디렉터리의 runtime/e2e/<run_id>/ 아래에 둔다.
4. EXEC의 인프라 profile을 harness-exec로 foreground 실행해 살아 있는 tool session/PID로 보존하고, 같은 방식으로 서버 profile을 시작한다. E2E profile은 별도 호출에서 서버·인프라 readiness를 다시 검사한다. 시작 PID와 receipt 경로를 기록하고 이 run이 소유한 CLI에만 SIGTERM을 전달하여 정리한다. 대상 애플리케이션과 필요한 인프라가 준비된 뒤, 지정된 브라우저/UI/API 절차로 엔드유저 시나리오를 실행한다. 시작한 프로세스의 로그·종료 코드·URL을 수집하고, 성공·실패·timeout·환경 차단을 구분한다. 로그·스크린샷·임시 결과는 세션 디렉터리의 runtime/e2e/<run_id>/ 아래에 저장한다.
5. 실행 종료, 시작 실패, 테스트 실패, timeout 모두에서 정리 절차를 수행한다. 소유한 서버/인프라 프로세스를 종료한 뒤 다음 cleanup hook을 실행한다.

   ```bash
   node .codex/skills/e2e-test/scripts/artifact-guard.mjs cleanup --root <worktree> --manifest <session_directory>/runtime/e2e/<run_id>/artifacts.json
   ```

6. cleanup hook 결과를 확인한다. 실행 전부터 있던 untracked/ignored 경로는 보존되어야 하고, 실행 후 새로 생긴 경로는 제거되어야 한다. cleanup이 실패하거나 새 산출물이 남으면 결과를 `inconclusive`로 보고하고 남은 경로를 명시한다.
7. Git 변경사항을 기록해 테스트 산출물이 tracked/staged 상태가 아닌지 확인한다. 테스트 runner는 `git add`, `git commit`, `git push`, merge를 실행하지 않는다.

## 결과 보고

적용 lesson ID, 실패별 evidence/원인 가설/예방 조치 필요 여부와 `tests.e2e_failures` 입력, 활성 워크트리 경로, 정확한 실행 명령, 시작한 서비스와 endpoint, polling 간격 및 timeout, 결과 증거, 프로세스 종료 여부, artifact cleanup 결과를 보고한다. 환경이 준비되지 않았거나 cleanup을 입증할 수 없으면 통과로 처리하지 않는다.

## 소유 worktree 종료

`session-worktree`의 공통 종료 규칙을 적용한다. top-level workflow 완료·실패·사용자 중단·handoff에서 소유 writer/agent/서버 종료를 확인한 뒤 archive·검증·제거를 finally로 수행한다. 내부 subagent/개별 단계가 공유 session worktree를 지우지 않는다. 구현의 owned plan worktree는 WorktreeManager가 개별 정리하고, sequential execution_line은 상위 workflow 종료 시 정리한다. branch/HEAD/recovery_path/return_root를 남기고 downstream은 보존한 branch로 새 경로를 만든다. cleanup 실패는 완료 실패이며, branch·백업·비소유 workspace를 삭제하지 않는다.

## 세션 출력

`docs/agents/EXEC.md`의 세션 파일 출력 경계를 따른다. `harness-session-output.mjs --root <workspace_root>`로 절대 `session_directory`를 구하고 모든 agent/tool에 전달한다. 로그·임시 파일·스크린샷·실행 증거는 그 아래에만 저장한다. 각 process의 TMPDIR/TMP/TEMP와 browser output 경로도 지정한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로에 둔다.

## 테스트·서비스 실행 전제

테스트·서버·인프라 명령은 `docs/agents/EXEC.md`와 해당 프로젝트의 `docs/agents/execution.json`을 먼저 대조한 뒤 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile <id>`로만 실행한다. 필수 인자·환경값·설정 prepare/verify·인프라와 선행 서버 readiness가 실제 entrypoint와 일치해야 한다. 프로필 누락/실패 시 직접 명령으로 우회하지 않는다. caller가 프로필을 보완하고 runner는 설정을 추정·수정하지 않는다. 설정/의존성/시작 인자가 바뀐 구현은 프로필·EXEC도 함께 갱신한다. 결과에는 실행 profile·receipt·실제 준비/검증 실패를 포함한다.
