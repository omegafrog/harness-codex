# 서브에이전트 실행과 결과

준비된 stage는 현재 worktree에서 실행한다. `node .codex/scripts/harness-native-stage.mjs start --root <workspace_root> --worktree-ref <worktree_ref> --execution-id <execution_id>`는 입력과 출력 schema를 준비하고 실행을 원자적으로 예약한다. 중복 예약이나 이미 실행 중인 stage는 중단한다. 반환된 `agent_profile`, `binding`, `guide`, `input_path`, `schema_path`, `output_path`를 사용한다.

현재 CLI의 native 서브에이전트 도구를 호출한다. Codex는 `spawn_agent`, Claude Code는 `Agent` 도구를 사용한다. 호출이 완료 전에 실제 agent ID를 반환하고 해당 agent에 메시지를 전달할 수 있어야 한다. Claude Code에서는 이를 지원하는 경우 백그라운드로 시작한다. 이 기능이 없으면 agent를 시작하기 전에 실패를 보고한다. 반환된 `agent_profile` role을 지정하고 그 profile의 sandbox 및 권한을 유지한다. profile을 선택할 수 없거나 지정된 권한을 적용할 수 없으면 실행하지 말고 실패를 보고한다. 반환된 `binding`의 model과 reasoning effort를 지원하는 도구에 그대로 지정한다. 독립 리뷰 등 fresh context가 필요한 role의 기존 규칙을 유지한다. 에이전트는 실제 agent ID를 전달받기 전 작업을 시작하지 않는다. 에이전트에 다음을 전달한다.

- 반환된 `guide`와 `input_path`, `.codex/internal-skills/skill-execution/worker-base.md`를 읽고 입력에 지정된 stage를 수행한다.
- `schema_path`의 JSON schema를 읽고 그 형식에 맞는 JSON을 `output_path`에 작성한다. 읽기 전용 profile이면 JSON 전체를 마지막 응답으로 반환한다. 실제 경로는 반환값을 그대로 사용한다.
- Harness CLI 명령은 `node .codex/scripts/harness-native-command.mjs --root <workspace_root> --execution-id <execution_id> --agent-id <agent_id> -- node .codex/scripts/<명령> ...`로 실행한다. 래퍼가 이 실행에 필요한 정확한 stage 환경을 전달한다.
- 입력에 참조된 이전 결과, 답변, feedback을 읽어 결정과 진행 상태를 보존한다. 필요 없는 질문이나 승인을 만들지 않는다.

도구가 반환한 실제 agent ID를 즉시 `node .codex/scripts/harness-native-stage.mjs bind --root <workspace_root> --worktree-ref <worktree_ref> --execution-id <execution_id> --agent-id <agent_id>`로 기록한다. ID를 추정하지 않는다. bind가 성공하면 그 실제 ID를 해당 에이전트에게 전달해 작업을 시작시킨다. 실제 서브에이전트의 종료를 native 도구로 기다린다. 읽기 전용 profile이면 해당 도구가 반환한 JSON 원문을 `harness-native-stage.mjs receive --root <workspace_root> --worktree-ref <worktree_ref> --execution-id <execution_id> --agent-id <agent_id>`의 표준 입력으로 전달한다. 응답을 수정하거나 재구성하지 않는다. 종료하지 않은 agent에 같은 작업을 중복 위임하지 않는다. 성공 또는 유효한 반환 결과가 나오면 같은 worktree에서 `node .codex/scripts/harness-native-stage.mjs finish --root <workspace_root> --worktree-ref <worktree_ref> --execution-id <execution_id>`를 실행한다. `format_error`이면 반환된 `errors`의 `path`, `rule`, `expected`, `value`를 **같은 서브에이전트에 전달**해 schema와 실제 파일을 다시 읽고 출력을 수정하게 한다. 수정 결과를 받은 뒤 같은 `finish`를 다시 실행한다. 오류를 숨기거나 임의로 출력 파일을 고치지 않는다. 에이전트가 반복해서 같은 오류를 고치지 못하거나 중단·실패하면 오류를 보고하고 멈춘다.

서브에이전트 도구가 실패나 취소를 확인한 경우에만 `node .codex/scripts/harness-native-stage.mjs fail --root <workspace_root> --worktree-ref <worktree_ref> --execution-id <execution_id> --reason <실제 실패>`로 실패를 기록한다. 사용자가 중단을 명시하고 서브에이전트의 종료가 확인된 경우에는 같은 명령의 `cancel`을 사용한다. 도구 반환 없이 에이전트가 종료했다고 추정하지 않는다. 세션 중단으로 agent의 상태가 불명확하면 자동 재실행하지 않고 기존 세션의 실제 상태를 확인한다.

`finish` 성공은 형식 검증 후 정본 결과를 기록한다. 보안 경계, workspace·실행 ID, 실제 승인과 결과 참조의 검증은 그대로 적용한다. 반환된 status와 code에 따라 사용자 질문·리뷰·다음 stage로 전환한다. 질문의 원문과 실제 사용자 답을 보존한다. 사용자 요청으로 중단된 경우 늦게 도착한 결과로 진행을 재개하지 않는다.

실패나 사용자 답변 뒤 새로운 실행을 준비하면 이전 결과와 입력을 제공받은 새 서브에이전트가 이어간다. 다른 CLI의 세션 ID를 넘기지 않는다. 단계별 독립 리뷰와 실제 E2E의 별도 승인 및 역할 요구사항은 해당 GUIDE를 따른다.

사용자가 완료된 `spec-me` 또는 `to-ticket` 산출물을 고치라고 지시하면 `harness-prepare-input.mjs --feedback <사용자 지시 원문> --user-revision true`로 준비한다. 뒤 stage의 대기 질문은 그 지시로 대체되며 사용자 지시를 agent 판단으로 만들어 내지 않는다. Spec 변경 뒤 독립 리뷰와 영향 계획을 재검토한다.

실패한 stage와 사용자가 취소한 stage는 실제 종료가 확인된 뒤 같은 stage에 `--feedback`을 전달한다. `REVIEW_REQUIRED`는 실제 독립 reviewer 결과를 `--feedback`으로 돌려준다. 사용자 질문의 답은 실제 답만 `--answer`로 전달하며, 준비기가 만든 `answers.json`을 확인한다. 최종 E2E 실패의 구현 수정 승인과 E2E 재실행 승인은 별개다. 검증되지 않은 반환을 성공으로 바꾸거나 기존 상태를 직접 고치지 않는다.
