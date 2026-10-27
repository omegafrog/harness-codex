<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Worktree create

## 실행 모델과 반환

기본 `model_tier`는 `execution`이며 `agents.execution_model`와 `agents.execution_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [공통 skill 실행 계약](../skill-execution/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

작업 단위가 소유하는 session worktree를 준비한다.

## 절차

1. 원본 workspace의 절대 Git root를 확인한다.
2. workflow-compose의 요청은 `harness-skill-exec.mjs`가 원본 실행 권한으로 이 명령을 수행한다. 작업 agent는 반환된 `context.worktree_ref`를 읽는다. standalone lifecycle 실행은 원본 workspace에서 `node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace>`를 실행한다.
   생성 CLI는 설치된 consumer의 lock에 등록된 Harness 파일과 로컬 Harness 설정을 새 worktree에 준비하고 경로별 hook을 등록한다. 기존 branch의 파일·설정은 덮어쓰지 않으며 runtime 준비 실패도 생성 실패로 반환한다.
3. stdout의 `session_directory`를 기준으로 `<session_directory>/worktree.json`을 읽고 `workspace`를 `workspace_root`로 정한다.
4. `workspace_root`를 `cwd`로 지정해 `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json`을 실행한다. `valid: true`, `cwd`와 `git_root`의 경로 일치, `worktree_registered: true`를 확인한다.
5. 후속 명령과 agent/tool 호출마다 `workspace_root`를 `cwd`로 지정한다. 세션 재개 시 `worktree.json`에서 `workspace`와 `session_directory`를 다시 읽는다.

## CLI 입출력

[worktree CLI 지침](../session-worktree/references/worktree-cli.md)
