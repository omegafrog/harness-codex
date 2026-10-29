# Workflow 준비

사용자의 최초 요청 원문을 입력받는다.

1. 요청을 바탕으로 짧고 의미 있는 `plan_set_id`를 만든다.
2. 현재 프로젝트에서 `node .codex/scripts/harness-workflow-worktree.mjs create --plan-set-id <plan_set_id>`를 실행한다. 생성기가 작업 worktree와 `plan_set_id`가 기록된 정본 `worktree.json`을 만든다.
3. 생성 결과의 `session_directory`에 있는 `worktree.json`을 `worktree_ref`로 사용해 처리 상태와 함께 orchestrator에 반환한다. 실패한 경우 실패 사유를 반환한다.
4. 성공하면 orchestrator가 `worktree.json`에서 worktree 경로를 읽어 사용자에게 알리고, 해당 위치에서 새 세션을 열도록 안내한다.
