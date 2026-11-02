# Workflow 준비

setup이 준비한 main의 기준 commit에서 `harness-compose-workspace.mjs`로 worktree를 생성하고 준비 상태와 결과를 검증·기록한다. 준비 명령의 입력은 원본 요청과 실행 식별자이며, worktree 참조는 생성 후 산출물이다. setup의 session 출력은 원본 workspace에 둘 수 있으며 compose 실행 입력은 새 worktree에 기록한다.

`--plan-set-id`에는 사람이 읽을 feature slug를 전달한다. compose 실행기는 slug에 UUID를 붙여 고유한 `plan_set_id`를 만들고 정본 `worktree.json`에 저장한다. 이후 단계는 입력 slug를 재사용하지 않고 반환된 worktree 참조의 정본 ID만 사용한다.

명령이 `completed / OK`와 유효한 `worktree_ref`를 반환하면 사용자가 해당 worktree에서 새 메인 Codex 세션을 열어 orchestrator를 재개하도록 안내한다. 후속 stage 선택은 새 세션의 orchestrator가 담당한다.
