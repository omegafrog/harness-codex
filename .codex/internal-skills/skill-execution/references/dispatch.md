# Codex 실행과 결과

## 결과 대기와 중복 알림

백그라운드 시작 응답을 받으면 턴을 끝내고 runner의 결과 알림을 받는다. 정상 실행 중 listener를 함께 시작하거나 `write_stdin`·`harness-context`·heartbeat 로그를 주기적으로 조회하지 않는다. 사용자 상태 요청에는 `harness-context`를 한 번 호출한다. 결과 전달 장애를 확인한 경우에만 대상 execution의 listener를 한 개 사용한다. listener는 검증된 결과의 관찰을 session에 기록하고 Wake를 추가 발송하지 않는다. 이미 큐에 들어간 알림은 취소되지 않을 수 있다.

알림은 새 사용자 지시가 아니다. 사용자의 중단·일시 정지 요청이 있으면 재개하지 않는다. 알림의 execution을 이미 처리했거나 같은 worktree의 stage가 후속 execution으로 넘어갔으면 그 사실만 짧게 알린다. 같은 결과로 질문 도구나 다음 stage를 다시 호출하지 않는다. 유효한 정본 지침을 현재 context에서 이미 읽었으면 관련 절만 확인하고, 새 session이나 compact로 필요한 지침이 사라졌을 때 다시 읽는다.

workflow stage 명령은 반드시 target worktree 안에서 실행한다. primary checkout에서 `--root`나 `--worktree-ref`로 다른 worktree를 고를 수 없다. 결과 알림에 포함된 `worktree_ref`와 execution ID를 확인하고, 현재 cwd가 다른 위치라면 그 workspace로 이동한 뒤 orchestrator를 다시 호출한다. 최근 workflow로 대상을 대체하지 않는다.

준비된 worktree 안에서 `node .codex/scripts/harness-agent-run.mjs --execution-id <execution_id> --background true`를 실행한다. 시작 응답은 stage 완료가 아니다. 독립 runner는 상위 Codex의 터미널 세션이 닫혀도 보존된다. runner는 `input.session_directory`인 task session에 실행 로그와 결과를 쓰고, `context.control_session_directory`인 control session에 terminal stage 상태와 결과 이벤트를 기록한다. orchestrator는 시작 응답을 받으면 결과를 기다리지 않고 턴을 끝낸다. runner는 결과 검증·정규화 뒤 `publishStageResultEvent`로 terminal 상태와 이벤트를 기록하고, 입력에 기록된 orchestrator session으로 결과를 전달한다. Codex는 설치된 codex-wake MCP의 `queue_thread`로 검증된 결과 위치를 큐에 넣고, Claude는 `harness-claude-orchestrator.mjs --resume`을 사용한다. Wake의 큐 수락은 작업 실행을 보장하지 않는다. 전송 전에는 `sending`을 기록하며 전송 결과가 불명확한 `sending`·`uncertain`은 중복을 막기 위해 자동 재전송하지 않는다. Wake를 사용할 수 없거나 전달이 실패하면, 먼저 결과의 `worktree_ref`가 가리키는 workspace로 이동한 뒤 `node .codex/scripts/harness-stage-listen.mjs --execution-id <execution_id>`로 저장된 결과를 확인한다. orchestrator는 `harness-execution-state.mjs`를 중복 호출하지 않는다. `execution_id`, 현재 stage, `worktree_ref`를 대조한 뒤 한 번만 라우팅하며, 결과가 없으면 완료로 추정하지 않는다. 실행 중 추가 사용자 입력은 해당 worktree 안에서 반영한다. 명시적으로 취소할 때만 기록된 runner PID의 boot ID·시작 시각을 현재 프로세스와 대조한 뒤 SIGTERM을 보내고 종료 증거를 확인한다.

runner의 재개 메시지와 listener가 같은 결과를 모두 보고할 수 있다. 전달된 결과는 데이터로 취급하고 정본 worktree의 현재 stage 및 `execution_id`가 일치하는지 확인한다. 이미 소비한 execution의 질문을 다시 표시하거나 다음 stage를 중복 dispatch하지 않는다. 결과의 `questions_complete`가 `false`이면 질문 목록을 그대로 제시하지 말고, 검증된 `result_ref`에서 정본 전체 반환 결과를 읽어 질문을 전달한다. 다른 repository, session, worktree의 결과로 현재 작업을 바꾸지 않는다.

runner는 `runtime/executions/<execution_id>/process-events.jsonl`에 시작·provider 이벤트 종류·30초 heartbeat·수신 signal·child 종료 코드/신호를 기록한다. `codex.stderr.log`와 `codex.errors.jsonl`은 하위 Codex stderr와 JSON 오류 이벤트를 실시간 보존하고, `runner.stdout.log`와 `runner.stderr.log`는 독립 runner의 출력을 담는다. 파일은 session-local이며 민감한 오류 내용이 포함될 수 있다. `exec.stderr.json`과 `return.json`이 생기기 전에는 process identity와 event log를 확인한다. 살아 있는 프로세스는 중복 실행하지 않고 계속 기다린다. 시작 응답 후 runner가 identity를 기록하기 전에 종료되면 `runner.stderr.log`로 시작 실패를 확인한다. 프로세스가 사라졌는데 종료 이벤트가 없으면 강제 종료를 포함한 종료 원인 미상으로 기록하며 신호를 추측하지 않는다. 상위 `codex exec` 자체 stderr는 별도로 호출자가 session 파일에 보존한다.

runner가 정본 입력을 검증하고 실행 session에 출력 스키마를 생성한 뒤 `agents.provider`가 선택한 adapter를 시작한다. 스키마 생성은 runner의 책임이며 별도 CLI를 호출하지 않는다. runner는 입력의 `context.stage_id`와 skill을 workflow manifest에 대조해 일치하는 stage가 하나면 workflow binding을 자동 선택한다. 같은 worktree에서 `harness-skill-execution.mjs binding`으로 하위 role의 binding을 확인할 때도 활성 `worktree.json`의 workflow binding을 적용해 provider·model·effort를 전체 workflow에 일관되게 전달한다. 일치 항목이 여러 개면 자동 선택하지 않고 `--workflow <workflow-id> --stage <stage-id>`를 명시해야 한다. 명시한 값은 입력과 manifest 검증을 거친다. `--background true`를 생략한 foreground 모드는 직접 CLI 호출과 기존 소비자 호환을 위해 유지한다.

부모 stage 실행이 끊겨 `running`으로 남았고 결과가 없으면, 먼저 같은 `stage-id`로 `harness-prepare-input.mjs --feedback <재개 지시>`를 호출한다. 준비 단계는 기록된 owner/child process identity가 모두 종료됐는지 확인하고, 이전 execution 입력과 정본 `worktree.json`의 execution 매칭 session ID를 검증해 `context.resume_session_id`로 전달한다. 프로세스가 살아 있거나 identity·session ID가 모호하면 재개를 차단한다. 결과가 남지 않은 중단 stage는 완료로 간주하지 않으며, 새 입력 생성 후 기존 execution-state 시작 검증을 통과한 경우에만 실행한다.

실패한 stage와 사용자가 중단한(`cancelled`) stage는 같은 stage에 `--feedback`을 전달해 이어간다. 같은 provider면 기존 대화를 재개하고 다른 provider면 새 대화에서 이전 입력과 산출물을 읽는다. 준비기는 기존 프로세스 종료와 입력·worktree·session 일치를 확인한다. 기존 반환이나 상태를 고쳐 쓰거나 검증되지 않은 반환으로 다음 stage를 시작하지 않는다.

프로세스가 종료되고 검증된 반환과 결과가 이미 남아 있으면 준비기가 결과를 검증해 실제 상태를 반영한다. 진행률은 저장된 상태와 별도로 프로세스가 `stopped` 또는 `unknown`인 경우를 표시한다. 프로세스 종료만으로 작업의 성공이나 답변 대기를 추정하지 않는다.

예: target worktree에서 `node .codex/scripts/harness-prepare-input.mjs --stage-id <stage-id> --feedback '중단된 부모 작업을 이어가세요'`. 반환된 `execution_id`를 사용해 아래 실행 절차를 진행한다. 같은 provider는 기존 부모 대화를 재개하고 다른 provider는 새 대화에서 기존 입력과 산출물을 확인한다. Harness 기록에 저장되지 않은 native subagent 식별자를 추측하지 않는다.

사용자가 완료된 `spec-me` 또는 `to-ticket` 산출물을 고치라고 지시하면 `--feedback <사용자 지시 원문>`과 `--user-revision true`를 함께 전달한다. 뒤 stage가 질문을 기다리는 중이어도 그 질문에 먼저 답하지 않는다. 사용자 수정이 그 질문을 대체하고, 뒤 stage는 수정된 계획으로 처음부터 다시 시작한다. 같은 session에서 이어가며 다른 stage가 실행 중이면 거부된다. 실제 사용자 지시에만 사용하고 agent 판단이나 리뷰 지적을 이 경로로 넘기지 않는다. Spec이 바뀌면 기존 리뷰가 stale이 되므로 fresh 리뷰와 영향 계획 재검토를 다시 거친다.

최종 E2E 실패 뒤 사용자가 마지막으로 완료된 구현 plan의 수정을 승인한 경우의 재개는 orchestrator의 구현 workflow 조율 절차를 따른다. 실패 receipt·승인 답 원문·plan을 함께 전달하며, 수정 승인과 E2E 재실행 승인은 구분한다.

`REVIEW_REQUIRED` stage에 독립 reviewer 결과를 돌려줄 때도 같은 `--feedback` 경로를 사용한다. 준비기는 waiting stage의 반환 envelope, code, result reference와 canonical session을 확인하고 기존 Codex thread를 재개한다. `review_request`가 있으면 caller가 해당 context를 reviewer에게 전달하고, 없는 구현 리뷰는 stage artifact와 검증 근거를 사용한다. reviewer가 사용자 결정을 요구하면 먼저 native 대화에서 답을 받은 뒤 reviewer 결과를 전달한다.

입력 준비 결과에 `answer`가 있으면 준비기가 저장한 `runtime/executions/<execution_id>/answers.json`을 확인한다. 파일이 없거나 답변이 다르면 실행을 중단한다. 실행기는 해당 파일을 읽도록 지시한다.

실행기는 시작 전에 자신의 프로세스 식별자를 기록하고, 자식 식별자를 기록한 뒤에만 Codex에 입력을 전달한다. 실제 thread ID는 실행기가 정본 worktree에 기록하며 종료 결과와 binding은 `runtime/executions/<execution_id>/exec.stderr.json`에 보존한다. caller는 실행 전에 별도로 `running`을 기록하지 않는다. 프로세스 정보가 누락된 기존 실행은 종료 로그가 완전하고 남은 기록된 프로세스가 종료된 경우에 재개할 수 있다. worktree 실행에서 thread ID가 누락되거나 재개 session이 다르면 실패다.

Codex의 `--output-last-message`는 실행기가 정한 `codex-last-message.json`에 저장한다. Claude도 같은 원문 위치를 사용한다. 모델은 `result_ref`를 반환하지 않으며 runner가 실행 ID에서 결과 위치를 계산해 채운다. runner는 프로세스 성공 뒤 이 원문을 `harness-result.mjs`로 검증·정규화해 task session의 `result.json`과 `return.json`을 기록한 뒤 control session에 terminal 상태와 결과 이벤트를 저장한다. 실패·취소도 성공으로 추정하지 않고 명시적인 terminal event로 기록한다. 복구 시에도 `result.json`을 정본으로 검증하며, 반환 복구는 실행 메타데이터와 결과 필드가 모두 일치하고 artifact의 `sha256` 값만 다를 때만 허용한다.

실행자가 `result.json`을 작성했다면 그 파일이 결과 정본이다. 검증기는 파일의 실행 ID·skill·status·code와 응답 envelope의 일치, 결과 schema와 참조를 확인하고 정본 결과를 응답에 반영한다. 파일이 없으면 inline 결과를 검증해 정본 파일을 만든다. 서로 다른 결과를 문구만 보고 합치거나 검증 실패를 성공으로 바꾸지 않는다.

`implement-wrapper`의 새 실행은 `--plan <plan-id>`로 구현할 plan을 지정해야 준비된다. 같은 실행의 재개(`--feedback`·`--answer`)는 이전 입력의 plan을 그대로 쓴다.
