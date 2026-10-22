<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Session worktree

workflow의 소유 worktree를 첫 단계 전에 준비하고, 정상 완료·실패·사용자 중단·top-level handoff가 끝날 때 반드시 정리한다. 내부 단계 전환이나 단순 질문 대기는 종료가 아니다. 사용자 취소/중단으로 workflow를 끝내면 `aborted`로 정리한다.

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
- 종료 결과의 `state: removed`와 Git 등록 해제를 확인하고 recovery_path·branch·HEAD·return_root를 전달한다. 다음 작업은 삭제된 경로를 쓰지 않는다. downstream은 보존한 branch로 새 worktree를 만든다. branch와 복구 ref는 삭제하지 않는다.
- tracked/untracked/ignored 파일과 staged index는 세션 디렉터리의 recovery/에 보존한다. journal과 로그는 같은 세션의 원래 경로에 남긴다. tree/HEAD/index 검증 후에만 삭제한다. archive 실패·활성 writer·Git lock 등으로 제거가 실패하면 정확한 경로·오류·재시도 명령을 보고하고 완료하지 않는다. `--force`로 백업 실패를 우회하지 않는다.
- SIGINT/SIGTERM을 받은 공통 CLI는 안전한 종료 처리를 끝낸다. SIGKILL·전원 종료에서는 즉시 finally를 실행할 수 없다. 소유 receipt와 cleanup lock은 남으므로 다음 진입에서 중단 실행을 확인하고 list→finish로 재시도한다. 잠금 해제나 다른 실행의 중단을 추정하지 않는다.

설정·복구·실행 상세는 `docs/agents/EXEC.md`를 따른다. recovery는 로컬 민감 파일을 포함할 수 있으므로 commit·push·tracker 게시를 하지 않는다.
