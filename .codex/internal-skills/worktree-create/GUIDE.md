<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Worktree create

작업 단위가 소유하는 session worktree를 준비한다.

## 절차

1. 원본 workspace의 절대 Git root를 확인한다.
2. 원본 workspace에서 `node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace>`를 실행한다.
3. stdout의 `session_directory`를 기준으로 `<session_directory>/worktree.json`을 읽고 `workspace`를 `workspace_root`로 정한다.
4. `workspace_root`를 `cwd`로 지정해 `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json`을 실행한다. `valid: true`, `cwd`와 `git_root`의 경로 일치, `worktree_registered: true`를 확인한다.
5. 후속 명령과 agent/tool 호출마다 `workspace_root`를 `cwd`로 지정한다. 세션 재개 시 `worktree.json`에서 `workspace`와 `session_directory`를 다시 읽는다.

## CLI 입출력

[worktree CLI 지침](../session-worktree/references/worktree-cli.md)
