# 스키마와 실행 상태

3. `node "<workspace_root>/.codex/scripts/harness-output-schema.mjs" --root "<workspace_root>" --worktree-ref <worktree_ref> --execution-id <execution_id>`으로 해당 실행의 출력 스키마를 생성한다.
   입력 준비 명령이 반환한 session에서 입력을 읽는다. worktree 작업의 schema·반환·실행 로그는 정본이 지정한 session에 저장한다. `waiting_for_answers`가 반환되면 실행하지 않고 답변을 기다린다.
4. 실행 시작·종료·실패는 `node "<workspace_root>/.codex/scripts/harness-execution-state.mjs" --root "<workspace_root>" --worktree-ref <worktree_ref> --execution-id <execution_id> --status <running|completed|action_required|blocked|failed|cancelled>`로 기록한다. 종료에는 실제 `--code`, `--result-ref` 또는 `--reason`을 전달한다. 입력에 `context.codex_session_id`, `context.stage_id`를 기록한다. 실행 중에는 실제 owner/child PID를 `--owner-pid`, `--child-pid`로 전달한다. 단계별 model binding을 지정할 때 `--workflow`, `--stage`를 함께 전달한다. 상태 파일을 직접 수정하지 않는다.
