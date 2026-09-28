---
name: e2e-test
description: Run full-stack end-user E2E tests in the active worktree, following repository execution instructions and cleaning test artifacts afterward.
---

# E2E 테스트 실행

실제 애플리케이션과 필요한 인프라를 띄우고 사용자 관점으로 검증해야 할 때 사용한다. 호출자는 활성 worktree 절대 경로를 확정하고 `.codex/harness.yaml`의 `agents.execution_model`, `agents.execution_reasoning_effort`를 해석한 뒤 `multi_agent_v1.spawn_agent`로 `agent_type="e2e_test_runner"`를 호출한다. `workspace_root`와 `cwd`에 동일한 경로를 지정하고, 사용자 시나리오·성공 조건·timeout을 전달하며 해석한 model/reasoning 값을 명시한다. 값이 없거나 실행기가 활성 worktree 경로에서 명령을 실행할 수 없으면 테스트하지 않고 blocker로 보고한다.

## 실행 절차

1. 현재 디렉터리와 `git rev-parse --show-toplevel`을 확인해 활성 워크트리 경로를 확정한다. 호출 세션에서 전달된 워크트리와 다르면 실행하지 않고 불일치를 보고한다. 이후 모든 명령의 working directory는 이 경로로 고정한다. 인프라를 시작하기 전에 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <worktree> --json`을 실행하고 `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다. 실패하면 서버나 테스트를 시작하지 않는다.
2. `docs/agents/EXEC.md`와 E2E 대상이 제공하는 실행 지침을 읽는다. 서버·인프라 준비, 환경 변수, 실행·대기·종료 명령을 그 문서에 따른다. 필요한 명령이나 전제가 없으면 추측해 환경을 변경하지 말고 blocker로 보고한다.
3. `.codex/skills/e2e-test/scripts/artifact-guard.mjs snapshot --root <worktree> --manifest <outside-worktree-file>`을 실행해 기존 untracked/ignored 경로를 기록한다. manifest는 작업 트리 외부의 임시 경로에 둔다.
4. 대상 애플리케이션과 필요한 인프라를 시작하고, 지정된 브라우저/UI/API 절차로 엔드유저 시나리오를 실행한다. 시작한 프로세스의 로그·종료 코드·URL을 수집하고, 성공·실패·timeout·환경 차단을 구분한다. 로그와 임시 결과 파일은 활성 worktree 외부에 저장한다.
5. 실행 종료, 시작 실패, 테스트 실패, timeout 모두에서 정리 절차를 수행한다. 소유한 서버/인프라 프로세스를 종료한 뒤 다음 cleanup hook을 실행한다.

   ```bash
   node .codex/skills/e2e-test/scripts/artifact-guard.mjs cleanup --root <worktree> --manifest <outside-worktree-file>
   ```

6. cleanup hook 결과를 확인한다. 실행 전부터 있던 untracked/ignored 경로는 보존되어야 하고, 실행 후 새로 생긴 경로는 제거되어야 한다. cleanup이 실패하거나 새 산출물이 남으면 결과를 `inconclusive`로 보고하고 남은 경로를 명시한다.
7. Git 변경사항을 기록해 테스트 산출물이 tracked/staged 상태가 아닌지 확인한다. 테스트 runner는 `git add`, `git commit`, `git push`, merge를 실행하지 않는다.

## 결과 보고

활성 워크트리 경로, 정확한 실행 명령, 시작한 서비스와 endpoint, polling 간격 및 timeout, 결과 증거, 프로세스 종료 여부, artifact cleanup 결과를 보고한다. 환경이 준비되지 않았거나 cleanup을 입증할 수 없으면 통과로 처리하지 않는다.
