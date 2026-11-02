# Codex 실행과 결과

준비된 worktree에서 `node .codex/scripts/harness-codex-run.mjs --worktree-ref <worktree_ref> --execution-id <execution_id>`를 실행한다. runner가 정본 입력을 검증하고 실행 session에 출력 스키마를 생성한 뒤 `codex exec --output-schema`를 시작한다. 스키마 생성은 runner의 책임이며 별도 CLI를 호출하지 않는다. workflow stage binding이 필요한 경우 `--workflow <workflow-id> --stage <stage-id>`를 함께 전달한다.

부모 stage 실행이 끊겨 `running`으로 남았고 결과가 없으면, 먼저 같은 `stage-id`로 `harness-prepare-input.mjs --feedback <재개 지시>`를 호출한다. 준비 단계는 기록된 owner/child process identity가 모두 종료됐는지 확인하고, 이전 execution 입력과 정본 `worktree.json`의 execution 매칭 session ID를 검증해 `context.resume_session_id`로 전달한다. 프로세스가 살아 있거나 identity·session ID가 모호하면 재개를 차단한다. 결과가 남지 않은 중단 stage는 완료로 간주하지 않으며, 새 입력 생성 후 기존 execution-state 시작 검증을 통과한 경우에만 실행한다.

프로세스가 종료되고 검증된 반환과 결과가 이미 남아 있으면 준비기가 결과를 검증해 실제 상태를 반영한다. 진행률은 저장된 상태와 별도로 프로세스가 `stopped` 또는 `unknown`인 경우를 표시한다. 프로세스 종료만으로 작업의 성공이나 답변 대기를 추정하지 않는다.

예: `node .codex/scripts/harness-prepare-input.mjs --worktree-ref <worktree_ref> --stage-id <stage-id> --feedback '중단된 부모 작업을 같은 대화에서 이어가세요'`. 반환된 `execution_id`를 사용해 아래 실행 절차를 진행한다. 기존 parent Codex 대화를 이어가 native subagent 기록과 위임 context를 확인한다. Harness 기록에 저장되지 않은 native subagent 식별자를 추측하지 않는다.

`REVIEW_REQUIRED` stage에 독립 reviewer 결과를 돌려줄 때도 같은 `--feedback` 경로를 사용한다. 준비기는 waiting stage의 반환 envelope, code, result reference와 canonical session을 확인하고 기존 Codex thread를 재개한다. `review_request`가 있으면 caller가 해당 context를 reviewer에게 전달하고, 없는 구현 리뷰는 stage artifact와 검증 근거를 사용한다. reviewer가 사용자 결정을 요구하면 먼저 native 대화에서 답을 받은 뒤 reviewer 결과를 전달한다.

입력 준비 결과에 `answer`가 있으면 준비기가 저장한 `runtime/executions/<execution_id>/answers.json`을 확인한다. 파일이 없거나 답변이 다르면 실행을 중단한다. 실행기는 해당 파일을 읽도록 지시한다.

실행기는 시작 전에 자신의 프로세스 식별자를 기록하고, 자식 식별자를 기록한 뒤에만 Codex에 입력을 전달한다. 실제 thread ID는 실행기가 정본 worktree에 기록하며 종료 결과와 binding은 `runtime/executions/<execution_id>/exec.stderr.json`에 보존한다. caller는 실행 전에 별도로 `running`을 기록하지 않는다. 프로세스 정보가 누락된 기존 실행은 종료 로그가 완전하고 남은 기록된 프로세스가 종료된 경우에 재개할 수 있다. worktree 실행에서 thread ID가 누락되거나 재개 session이 다르면 실패다.

프로세스 성공 뒤 `node .codex/scripts/harness-result.mjs --root <workspace_root> --worktree-ref <worktree_ref> --execution-id <execution_id> --return runtime/executions/<execution_id>/return.json`으로 결과를 검증하고 `harness-execution-state.mjs`로 실제 완료·실패 상태를 기록한다. 결과에 따라 orchestrator가 다음 단계를 선택한다.

실행자가 `result.json`을 작성했다면 그 파일이 결과 정본이다. 검증기는 파일의 실행 ID·skill·status·code와 응답 envelope의 일치, 결과 schema와 참조를 확인하고 정본 결과를 응답에 반영한다. 파일이 없으면 inline 결과를 검증해 정본 파일을 만든다. 서로 다른 결과를 문구만 보고 합치거나 검증 실패를 성공으로 바꾸지 않는다.
