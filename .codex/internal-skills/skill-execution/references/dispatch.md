# Codex 실행과 결과

준비된 worktree에서 `node .codex/scripts/harness-codex-run.mjs --worktree-ref <worktree_ref> --execution-id <execution_id>`를 실행한다. 입력과 schema·반환 경로, 모델·effort, 재개 session은 정본과 해당 실행 입력에서 해석한다. workflow stage binding이 필요한 경우 `--workflow <workflow-id> --stage <stage-id>`를 함께 전달한다.

부모 stage 실행이 끊겨 `running`으로 남았고 결과가 없으면, 먼저 같은 `stage-id`로 `harness-prepare-input.mjs --feedback <재개 지시>`를 호출한다. 준비 단계는 기록된 owner/child process identity가 모두 종료됐는지 확인하고, 이전 execution 입력과 정본 `worktree.json`의 execution 매칭 session ID를 검증해 `context.resume_session_id`로 전달한다. 프로세스가 살아 있거나 identity·session ID가 모호하면 재개를 차단한다. 결과가 남지 않은 중단 stage는 완료로 간주하지 않으며, 새 입력 생성 후 기존 execution-state 시작 검증을 통과한 경우에만 실행한다.

예: `node .codex/scripts/harness-prepare-input.mjs --worktree-ref <worktree_ref> --stage-id <stage-id> --feedback '중단된 부모 작업을 같은 대화에서 이어가세요'`. 반환된 `execution_id`를 사용해 아래 실행 절차를 진행한다. 기존 parent Codex 대화를 이어가 native subagent 기록과 위임 context를 확인한다. Harness 기록에 저장되지 않은 native subagent 식별자를 추측하지 않는다.

입력 준비 결과에 `answer`가 있으면 해당 실행의 `runtime/executions/<execution_id>/answers.json`에 저장한다. 실행기가 답변 파일을 읽도록 지시한다.

실행기의 stderr에서 `started.pid`와 `thread.started.thread_id`를 받으면 각각 `harness-execution-state.mjs`로 실행 중 상태를, `harness-workflow-session.mjs`로 정본 worktree에 stage session을 기록한다. 실행기는 종료 결과와 실제 binding을 `runtime/executions/<execution_id>/exec.stderr.json`에 보존한다. worktree 실행에서 thread ID가 누락되거나 재개 session이 다르면 실패다.

프로세스 성공 뒤 `node .codex/scripts/harness-result.mjs --root <workspace_root> --worktree-ref <worktree_ref> --execution-id <execution_id> --return runtime/executions/<execution_id>/return.json`으로 결과를 검증하고 `harness-execution-state.mjs`로 실제 완료·실패 상태를 기록한다. 결과에 따라 orchestrator가 다음 단계를 선택한다.

실행자가 `result.json`을 작성했다면 그 파일이 결과 정본이다. 검증기는 파일의 실행 ID·skill·status·code와 응답 envelope의 일치, 결과 schema와 참조를 확인하고 정본 결과를 응답에 반영한다. 파일이 없으면 inline 결과를 검증해 정본 파일을 만든다. 서로 다른 결과를 문구만 보고 합치거나 검증 실패를 성공으로 바꾸지 않는다.
