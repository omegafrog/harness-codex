---
model_tier: execution
---
# E2E 테스트 실행

먼저 [공통 검증 정책](references/verification-policy.md)을 적용한다. implement-wrapper가 split plan set의 최종 검증으로 호출하면 모든 split plan 구현·개별 검증·통합이 끝난 뒤 feature-level E2E를 한 번 실행한다. 개별 plan 구현 중에는 실행하지 않는다. 승인된 시나리오와 oracle을 사용하며, plan/test contract에 정의된 시나리오와 충돌하면 실행 전에 근거 있는 수정안을 제시한다. Runner는 테스트/source를 수정하지 않는다. 그 밖의 독립 작업에서는 명시된 E2E 요청 또는 저비용 검사로 판정할 수 없는 승인된 critical cross-boundary 위험에 대해서만 실행한다.

implement-wrapper의 최종 E2E는 전체 통합 코드 리뷰 pass 뒤 caller가 작성·제시한 시나리오의 명시적 사용자 실행 승인을 요구한다. runner는 승인된 시나리오·대상 commit·실행 조건과 실제 답변 참조를 확인하고, 누락되거나 달라졌으면 서버/인프라를 시작하지 않고 `USER_DECISION_REQUIRED`를 반환한다. 이전 계획 승인이나 구현 진행 지시는 실행 승인을 대신하지 않는다. 실패·timeout·환경 차단·cleanup 실패 뒤에는 증거 수집과 소유 자원 정리만 수행하고 중단한다. caller도 코드·테스트·profile을 자동 수정하거나 자동 재실행하지 않고 사용자에게 결과와 제안 조치의 승인을 요청한다. 단 증거로 테스트 코드 자체의 결함이 확정된 실패는 [테스트 코드 결함 빠른 경로](references/test-defect-fast-path.md)를 따른다.

E2E는 항상 호출자와 대화를 공유하지 않는 fresh `e2e_test_runner` 하위 agent가 실행한다. `e2e_test_runner`로 실행 중이면 아래 실행 절차를 직접 수행하고 다른 runner를 호출하지 않는다. 호출자는 runner를 새로 띄워 승인 근거만 넘기고 직접 E2E를 실행하지 않는다. 활성 worktree의 절대 `workspace_root`를 확정하고 `<workspace_root>/docs/agents/testing-guidance.md`를 먼저 읽는다. 호출자는 runner에 `workspace_root`와 `cwd`에 동일한 경로, 승인된 실행 근거, scenario/oracle, profile, timeout, 현재 시도 및 남은 budget을 전달한다. model/reasoning은 호출기가 setup 설정에서 읽는다. 값이 없거나 실행기가 활성 worktree 경로에서 명령을 실행할 수 없으면 테스트하지 않고 blocker로 보고한다.

프로젝트의 검증 기능 지도(있으면 `docs/verification/features.md`)에서 관련 시나리오·requirement/rule ID·진입점·성공 결과를 읽는다. 기능 변경으로 지도가 달라지면 검증한 항목만 갱신한다. 지도의 생성·전체 정합성 점검은 `maintain-verification`을 사용하며, 여기서는 요청된 범위의 실제 실행만 맡는다. 성능 목표가 있으면 plan의 workload·baseline·지표와 measurement 증거 계약을 따른다.

## 실패 학습과 다음 실행

Caller와 runner는 [실패 재발 방지](references/failure-learning.md)를 읽는다. 실행 전 프로젝트의 현행 `docs/verification/e2e-lessons.md`와 예방 검사를 확인한다. 실패 후 caller는 runner의 증거를 바탕으로 원인과 재사용 가능성을 분류한다. implement-wrapper의 최종 E2E에서는 사용자 결정 전 설정 수정이나 재검증을 시작하지 않으며, 승인된 조치 뒤 검증된 lesson·활성 workspace testing guidance를 갱신한다. runner는 시도별 증거와 `tests.e2e_failures` 입력을 반환하며 수정/학습 완료를 추정하지 않는다. 과거 실패 이력은 다음 성공 뒤에도 보존한다. 현재 테스트 결과와 학습 상태는 별개이며 지침 갱신·학습 분류 누락으로 테스트 통과나 workflow 완료를 차단하지 않는다.

## 실행 절차

1. 현재 디렉터리와 `git rev-parse --show-toplevel`을 확인해 활성 워크트리 경로를 확정한다. 호출 세션에서 전달된 워크트리와 다르면 실행하지 않고 불일치를 보고한다. 이후 모든 명령의 working directory는 이 경로로 고정한다. 인프라를 시작하기 전에 `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <worktree> --json`을 실행하고 `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다. 실패하면 서버나 테스트를 시작하지 않는다.
2. 활성 worktree의 `docs/agents/testing-guidance.md`, `docs/agents/EXEC.md`, E2E 대상의 실행 지침을 읽는다. 서버·인프라 준비, 환경 변수, 실행·대기·종료 명령은 활성 worktree의 프로젝트 계약을 따른다. 필요한 명령이나 전제가 없으면 추측해 환경을 변경하지 말고 blocker로 보고한다.
3. `ARTIFACT_GUARD=.codex/internal-skills/e2e-test/scripts/artifact-guard.mjs`로 지정하고 `node "$ARTIFACT_GUARD" snapshot --root <worktree> --manifest <session_directory>/runtime/e2e/<run_id>/artifacts.json`을 실행해 기존 untracked/ignored 경로를 기록한다. manifest는 공통 resolver로 구한 세션 디렉터리의 runtime/e2e/<run_id>/ 아래에 둔다.

   cleanup에는 이번 실행이 만든 임시 파일임을 개별 확인한 경로만 `--owned <worktree-relative-path>`로 반복 전달한다. 새 Spec·계획·제품 코드 등 workflow 산출물과 소유권이 불명확한 경로는 삭제하지 않고 반환된 `preserved`에 기록한다. `--owned`를 생략하면 새 파일을 삭제하지 않는다.
4. `purpose: "e2e"`가 지정된 EXEC 인프라 profile을 harness-exec로 foreground 실행해 살아 있는 tool session/PID로 보존하고, 같은 방식으로 E2E server profile을 시작한다. E2E profile은 별도 호출에서 서버·인프라 readiness를 다시 검사한다. 시작 PID와 receipt 경로를 기록하고 이 run이 소유한 CLI에만 SIGTERM을 전달하여 정리한다. 대상 애플리케이션과 필요한 인프라가 준비된 뒤, 지정된 브라우저/UI/API 절차로 엔드유저 시나리오를 실행한다. 시작한 프로세스의 로그·종료 코드·URL을 수집하고, 성공·실패·timeout·환경 차단을 구분한다. 로그·스크린샷·임시 결과는 세션 디렉터리의 runtime/e2e/<run_id>/ 아래에 저장한다.
5. 실행 종료, 시작 실패, 테스트 실패, timeout 모두에서 정리 절차를 수행한다. 소유한 서버/인프라 프로세스를 종료한 뒤 다음 cleanup hook을 실행한다.

   ```bash
   node "$ARTIFACT_GUARD" cleanup --root <worktree> --manifest <session_directory>/runtime/e2e/<run_id>/artifacts.json
   ```

6. cleanup hook 결과를 확인한다. 실행 전 경로와 `.io` 증거, 새 workflow 산출물은 보존하고 소유한 임시 파일은 제거한다. `preserved`를 검토해 미확인 임시 파일이 남았거나 cleanup이 실패하면 `inconclusive`로 보고하고 해당 경로를 명시한다.
7. Git 변경사항을 기록해 테스트 산출물이 tracked/staged 상태가 아닌지 확인한다. 테스트 runner는 `git add`, `git commit`, `git push`, merge를 실행하지 않는다.

## 결과 보고

적용 lesson ID, 실패별 evidence/원인 가설/예방 조치 필요 여부와 `tests.e2e_failures` 입력, 활성 워크트리 경로, 정확한 실행 명령, 시작한 서비스와 endpoint, polling 간격 및 timeout, 결과 증거, 프로세스 종료 여부, artifact cleanup 결과를 보고한다. 환경이 준비되지 않았거나 cleanup을 입증할 수 없으면 통과로 처리하지 않는다.

## 소유 worktree

상위 workflow가 전달한 worktree를 그대로 쓰고 소유권·종료를 다루지 않는다. 직접 소유한 실행이면 [session-worktree](../../../.codex/internal-skills/session-worktree/GUIDE.md)를 따른다.

## 실행 산출물 경로

실행 중 생기는 로그·임시 파일·스크린샷은 [실행 산출물 경로](../../../.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md)를 따른다.

## 테스트·서비스 실행 전제

테스트·서버·인프라 명령은 `docs/agents/EXEC.md`와 해당 프로젝트의 `docs/agents/execution.json`을 먼저 대조한 뒤 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile <id>`로만 실행한다. 필수 인자·환경값·설정 prepare/verify·인프라와 선행 서버 readiness가 실제 entrypoint와 일치해야 한다. 프로필 누락/실패 시 직접 명령으로 우회하지 않는다. caller가 프로필을 보완하고 runner는 설정을 추정·수정하지 않는다. 설정/의존성/시작 인자가 바뀐 구현은 프로필·EXEC도 함께 갱신한다. 결과에는 실행 profile·receipt·실제 준비/검증 실패를 포함한다.

Harness black-box 관찰자는 내부 stage 실패나 모델 자체 복구를 이유로 outer Codex·timeout wrapper·stage runner·listener에 종료 신호를 보내지 않는다. 그 동작을 관찰·기록하며, 관찰자의 종료는 사용자의 명시적 취소 지시가 있을 때만 허용한다. 앱·인프라 cleanup 권한은 테스트 대상 workflow를 종료할 권한이 아니다.
