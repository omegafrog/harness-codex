<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Session worktree

workflow의 소유 worktree를 첫 단계 전에 준비하고, 정상 완료·실패·사용자 중단·top-level handoff가 끝날 때 반드시 정리한다. `completed`는 해당 workflow의 completion kind가 뜻하는 산출물만 완료됐다는 뜻이지, 다음 workflow나 기능 구현 전체가 끝났다는 뜻이 아니다. 내부 단계 전환이나 단순 질문 대기는 종료가 아니다. 사용자 결정·외부 조건을 기다리면 상태를 `waiting`으로 기록하고 세션/worktree를 유지한다. 사용자 취소/중단으로 workflow를 끝내면 `aborted`로 정리한다.

## 구현 workflow의 예외

`implement-wrapper`와 `implement`에서는 병렬 계획의 격리가 필요한 경우에만 새 worktree를 생성한다. 순차 구현은 사용자가 지정한 기존 작업 위치를 `execution_line`/`workspace_root`로 재사용하며, 아래 준비 절차의 create/reserve/register를 적용하지 않는다. workflow 소유 receipt가 없다는 이유로 별도 session worktree를 만들거나 기존 위치에 소유권을 붙이지 않는다. 이 예외는 구현 중 호출하는 `sync-contracts`, review, E2E, PR 절차에도 적용한다.

작업 위치는 현재 요청과 plan의 명시적인 실행 경로를 대조해 확정한다. 과거 checkpoint·receipt·Architecture review의 `session_worktree`는 이력이며 현재 경로를 바꾸는 근거가 아니다. 경로가 충돌하면 쓰기 전에 확인하고, 순차 재개·plan 전환·병합 후에도 확정한 경로를 유지한다. preflight의 `expected-root`는 그 경로를 사용하며 검사 통과를 위해 다른 경로로 바꾸지 않는다.

순차 `execution_line`은 구현 workflow의 생성·삭제 대상이 아니다. 병렬 계획 worktree만 `WorktreeManager`로 생성·통합·정리한다. 상위 Spec/계획 workflow가 소유한 worktree는 해당 소유자의 lifecycle을 따르며, 구현 하위 단계가 소유권을 가져오거나 제거하지 않는다.

## 준비

1. 실제 Git root·branch·HEAD·porcelain·등록 worktree를 확인한다. `harness-workflow-worktree.mjs list --root <return_root>`로 이전 미종료 receipt를 확인한다. 이전 실행이 끝난 것이 확인된 소유 worktree만 `finish`로 복구 정리하며 다른 실행의 활성 worktree를 지우지 않는다.
2. 동일 workflow의 active 소유 receipt가 있는 linked worktree만 재사용한다. 임의의 사용자 linked worktree에 자동으로 소유권을 붙이지 않는다. 그 밖에는 `node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace> --workflow <workflow-id>`로 새 sibling worktree와 branch를 생성한다. source는 named branch와 clean 상태여야 한다. 공통 코드가 Git add 전부터 소유권을 기록한다.
3. 앞 workflow가 제거된 경우 보존한 `session_branch`로 `create ... --branch <session_branch>`를 호출하여 새 경로를 만든다. branch를 새로 나누거나 원격 fetch/merge하지 않는다. 미커밋 중단 상태를 재개할 때는 recovery snapshot의 files/index를 EXEC 절차로 먼저 복원한다.
4. 반환값의 `workspace`, `branch`, `return_root`, `session_directory`를 절대 경로와 branch로 보존한다. 생성 직후부터 설치·preflight·agent 오류도 아래 종료 처리 대상이다.
   `return_root`는 project-specific implementation/testing guidance의 공용 원본 경로인 `shared_guidance_root`이기도 하다. 모든 agent에 전달하고, 두 경로가 같은 Git common directory인지 확인한다.
5. source의 Git 비관리 `.codex/harness.yaml`이 target에 없으면 덮어쓰기 없이 복사한다. source checkout에서는 source의 `bin/harness-install.mjs install --project <session_worktree> --force`, consumer는 기존 install 명령으로 runtime을 설치한다. 실패하면 `finally`에서 정리한다.
6. 내부 절차는 source와 consumer 모두 `.codex/internal-skills/<skill>/GUIDE.md`를 읽는다. 공개 스킬은 source checkout의 `.codex/skills/<skill>/SKILL.md`, consumer의 `.agents/skills/<skill>/SKILL.md`를 읽는다. 필요한 skill/agent/workflow를 확인한 후 worktree를 cwd로 `harness-workspace-preflight.mjs --expected-root <session_worktree> --json`을 실행한다. valid/cwd/git_root/등록 linked worktree가 일치해야 단계를 시작한다.
7. `harness-session-output.mjs --root <session_worktree>`로 `session_directory`를 확인한다. 모든 로그·임시 파일·실행 증거·복구 자료는 그 안에만 둔다. EXEC의 세션 파일 출력 경계를 적용하고 모든 agent/tool에 정확한 절대 `workspace_root`, `session_directory`와 `cwd`를 전달한다. 다음 호출에 이전 cwd가 자동 상속된다고 가정하지 않는다.

## 모든 종료 경로

- 정상 완료는 `harness-workflow-complete.mjs`를 호출한다. 이 명령은 gate 결과와 관계없이 outer finally에서 소유 worktree를 archive·검증·제거한다. cleanup 실패 시 정상 완료로 보고하지 않는다.
- 실패·중간 중단·사용자 취소·설치 실패·handoff 시 소유 child agent/서버/쓰기 작업을 먼저 종료하고 결과를 기다린다. 실패 원인과 재개 지점을 기록한 뒤 **보존한 return_root를 cwd로** `harness-workflow-worktree.mjs finish --root <session_worktree> --repository <return_root> --workflow <workflow-id> --outcome failed|aborted|handoff`를 실제 실행한다.
- 종료 receipt의 `outcome`은 `completed`, `failed`, `aborted`, `handoff`를 구분한다. 대기 중에는 finish/cleanup하지 않는다. handoff는 현재 단계 완료가 아니며, recovery 자료와 downstream 재개 경로만 전달한다.
- 종료 결과의 `state: removed`와 Git 등록 해제를 확인하고 recovery_path·branch·HEAD·return_root를 전달한다. 다음 작업은 삭제된 경로를 쓰지 않는다. downstream은 보존한 branch로 새 worktree를 만든다. branch와 복구 ref는 삭제하지 않는다.
- tracked/untracked/ignored 파일과 staged index는 세션 디렉터리의 recovery/에 보존한다. journal과 로그는 같은 세션의 원래 경로에 남긴다. tree/HEAD/index 검증 후에만 삭제한다. archive 실패·활성 writer·Git lock 등으로 제거가 실패하면 정확한 경로·오류·재시도 명령을 보고하고 완료하지 않는다. `--force`로 백업 실패를 우회하지 않는다.
- SIGINT/SIGTERM을 받은 공통 CLI는 안전한 종료 처리를 끝낸다. SIGKILL·전원 종료에서는 즉시 finally를 실행할 수 없다. 소유 receipt와 cleanup lock은 남으므로 다음 진입에서 중단 실행을 확인하고 list→finish로 재시도한다. 잠금 해제나 다른 실행의 중단을 추정하지 않는다.

설정·복구·실행 상세는 `docs/agents/EXEC.md`를 따른다. recovery는 로컬 민감 파일을 포함할 수 있으므로 commit·push·tracker 게시를 하지 않는다.
