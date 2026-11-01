# 실행 입력 준비

1. `node "<workspace_root>/.codex/scripts/harness-prepare-input.mjs" --worktree-ref <절대 worktree.json 경로> --stage-id <선택한 skill ID>`로 선택한 단계의 입력 파일을 준비한다.
2. 최초 workflow 구성은 메인 workspace에서 `node "<source_workspace>/.codex/scripts/harness-compose-workspace.mjs" --root "<source_workspace>" --execution-id <execution_id> --plan-set-id <plan_set_id> --request <사용자 요청 원문> --codex-session-id <hook의 실제 session ID>`로 준비한다. 요청 인자는 shell quoting을 적용한다. 이 명령은 worktree를 만들고 입력·검증된 결과·완료 상태를 그 worktree에 기록한다. 반환 상태와 `worktree_ref`를 확인한다. setup 출력은 원본 workspace의 `.io`에 둘 수 있다.
3. 대기 중인 내부 작업 요청은 같은 stage에 `--feedback <서브에이전트 직접 위임 요청>`을 전달해 부모 session에서 이어간다. 차단된 stage도 원인이 해소되면 `--feedback <해소 근거>`로 같은 session을 재개한다. 기존 결과와 session을 보존한다.
