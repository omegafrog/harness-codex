# 서브에이전트 실행과 결과

## 실행 배정

stage는 현재 worktree에서 `node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage> [준비 옵션]` 한 번으로 시작한다. 준비 옵션은 `harness-prepare-input.mjs`와 같다(`--answer`·`--feedback`·`--user-revision`·`--plan` 등). `--plan <ticket-id>`는 `tactical-code`가 ticket 하나를 구현할 때 쓰고(`harness-context.mjs`의 `ready_tickets`에서 고른다), `tracker-publish`는 `--publication-approved true --approval-answer '<사용자 답 원문>'`을 함께 받는다. `launch`는 입력을 준비한 뒤 `start`와 같이 출력 schema를 만들고 실행을 원자적으로 예약한다. 중복 예약이나 이미 실행 중인 stage는 중단한다. 반환된 `agent_profile`, `binding`, `guide`, `input_path`, `schema_path`와 `next.bind`·`next.finish`를 사용한다. 새 실행이 없는 경우(일부 답만 도착했거나 실행 중인 stage에 답을 저장한 경우)에는 준비기의 `waiting_for_*` 결과만 반환한다. 입력 준비와 예약을 따로 하는 `harness-prepare-input.mjs`와 `harness-native-stage.mjs start --execution-id <execution_id>`도 같은 계약으로 유지된다. 이 명령들은 현재 worktree에서 `--root`와 `--worktree-ref`를 스스로 찾으므로 붙이지 않는다.

출력은 기본이 compact다. `prepare`는 `execution_id`·`stage_id`·`next`만, `finish`는 `status`·`code`·`result_ref`·`next`와 요약·artifact(`kind`·`path`)·질문·리뷰 요청·`commit_sha`만 담고, `harness-context.mjs`는 끝난 stage를 한 줄로 줄인다. 전체 입력·해시·`result` 원문은 `--verbose`로만 출력하며 진단이 아니면 쓰지 않는다. 오류는 모두 `error`(무슨 일), `code`, `why`(이유)와 실행할 `next` 명령 또는 사용자에게 받을 `user_decision`을 가진 JSON 하나다. `next`를 그대로 따르고 원인을 찾으려고 Harness 소스나 state 파일을 읽지 않는다. 오류 `code`는 `STAGE_ORDER`·`NOT_RUNNING`·`PREVIOUS_RESULT_MISSING`·`PREVIOUS_UNRESOLVED`·`REVISION_TARGET`·`REVISION_REPEATED`·`USER_REVISION_REFUSED`·`RESTART_REFUSED`·`DISCARD_REFUSED`·`FEEDBACK_REFUSED`·`ANSWER_REFUSED`·`STAGE_RUNNING`·`NOT_BOUND`·`INPUT_NOT_FOUND`·`WRONG_WORKSPACE`·`FORMAT_ERROR`·`GATE_ERROR`·`RESULT_REJECTED`·`COMMIT_BLOCKED` 등이며 알 수 없는 오류도 `next`나 `user_decision`을 가진다.

stage가 정해졌으면 파일 조회를 시작하기 전에 `launch`부터 실행한다. `launch`가 설치된 GUIDE의 절대 경로를 반환한다. 오케스트레이터(메인 세션)는 이 값을 서브에이전트에 전달만 한다. `guide`·`input_path`·`schema_path`의 파일과 stage 산출물(Spec·plan·코드) 본문은 읽지 않는다. 서브에이전트는 전달받은 경로를 직접 연다. 메인은 `finish`가 출력하는 `status`·`code`·`result_ref`와 `result`의 요약·artifact 참조·질문만으로 다음 단계를 정한다. 리뷰어에게는 문서 경로만 넘기고 리뷰어가 직접 읽게 한다.

새 `execution_id`마다 반환된 `agent_profile`의 새 native 작업자를 시작한다. Codex는 `spawn_agent`에 `fork_turns: "none"`을 주고, 이름을 지정할 수 있으면 실행마다 다른 이름을 쓴다. Claude Code는 명시적 `subagent_type`으로 fresh `Agent`를 시작하며 필요하면 백그라운드로 실행한다. 이미 bind된 작업자에게 다음 실행을 맡길 수 없다. 작업자 ID 반환과 메시지 전달, 지정 profile의 sandbox·권한, `binding`의 모델과 effort를 현재 CLI에서 적용할 수 있을 때 시작한다. 보조 조사도 지명된 profile에 질문과 필요한 파일 범위만 맡긴다. 부모 이력이나 산출물 본문을 붙여 넣지 않는다. 작업자는 실제 ID를 받으면 반환된 `guide`·`input_path`·`schema_path`와 제공된 경우 `answers_path`·`feedback_path`를 읽는다. `workspace_root`, `execution_id`, bind한 실제 `agent_id`와 bind의 `receive_command`를 함께 건넨다. 별도의 공통 지침은 설치된 profile에서 읽는다.

Codex의 Harness 작업자 프로필은 `skills.include_instructions = false`로 자동 스킬 목록을 생략한다. 작업자는 배정된 GUIDE와 현재 단계에서 필요한 참조를 경로로 연다. 사용자가 배정된 작업에 외부 스킬을 명시했다면 해당 스킬 파일의 경로도 전달한다.

사용자가 이번 실행의 모델과 reasoning effort를 정하면 해당 stage를 `--stage-binding '{"provider":"codex","model":"gpt-6-luna","reasoning_effort":"medium"}'` 형식으로 준비한다. provider는 현재 workflow와 일치해야 한다. `--take-over true`로 이어받을 때도 같은 옵션을 전달한다. 이 값은 해당 실행에만 저장하고 worktree의 binding과 setup 설정은 유지한다. 여러 stage에 적용하라는 요청이면 범위에 해당하는 각 `launch`에 넘긴다. Codex `spawn_agent`에는 반환된 `binding.model`과 `binding.reasoning_effort`를 그대로 넣는다. 상위 세션의 실제 모델과 effort가 둘 다 일치하면 Codex의 상속도 사용할 수 있다. 현재 도구로 지정값을 적용할 수 없으면 멈추고 그 제한을 사용자에게 알린다. Codex `finish`는 지정값과 실제 작업자 기록이 일치한 결과만 받는다.

현재 전술 설계 양식은 작업자가 `completed/OK`를 제출할 때 소유 부분을 검증한다. `domain-model`은 모델 필드·메서드·업무 연결, `aggregate-design`은 Aggregate 구조·담당 규칙·클래스 다이어그램, `domain-service`는 남은 규칙 책임, `application-service`는 업무 커버리지·호출·트랜잭션·포트를 본다. `context-boundary`에서는 문서 전체를 다시 확인한다. 이전 번호식 문서는 기존 마지막 gate를 사용한다. `gate_error`는 결과나 commit을 남기지 않으며, 오류를 같은 작업자에게 돌려준다. 자기 산출물의 오류는 그 자리에서 고치고 다시 제출한다. 앞 stage의 오류는 `owner_stage`와 `dependency_gap`을 갖춘 `blocked/DEPENDENCY_INCOMPLETE`로 제출해 실제 소유자에게 보낸다.

## 작업자 대기와 실행 복구

서브에이전트 도구가 실패나 취소를 확인한 경우에만 `node .harness/scripts/harness-native-stage.mjs fail --execution-id <execution_id> --reason <실제 실패>`로 실패를 기록한다. 사용자가 중단을 명시하고 서브에이전트의 종료가 확인된 경우에는 같은 명령의 `cancel`을 사용한다. 도구 반환 없이 에이전트가 종료했다고 추정하지 않는다. 세션 중단으로 agent의 상태가 불명확하면 자동 재실행하지 않는다. 같은 대화에서는 기존 세션의 실제 상태를 확인하고, 다른 Codex 대화가 시작한 stage(`inspect`의 `session`이 `other`이거나 `harness-context`가 `next`로 안내)는 그 대화로 돌아가지 않고 아래 인계를 쓴다.

다른 Codex 대화가 시작한 `running` stage는 새 대화에서 `node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage> --take-over true`를 단독으로 실행해 인계한다. 실행기는 이전 orchestrator transcript가 이 worktree의 것이고 어느 process도 열고 있지 않은지, stage의 agent transcript도 닫혀 있는지, agent가 `finish`로 기록할 output을 남기지 않았는지, project worktree가 깨끗한지를 확인한다. 모두 확인되면 이전 state를 `runtime/restarts/takeover-*`에 보존하고 그 실행을 `failed/EXECUTION_ERROR`(중단, 결과 없음)로 기록하며 `orchestrator_session_id`를 현재 Codex session(`CODEX_THREAD_ID`)으로 옮긴다. 그리고 이전 입력과 이미 준 답을 이어받는 새 실행을 `--feedback`으로 예약해 `taken_over`가 붙은 `launch` 결과를 반환한다. 이후 `next.bind`·`next.finish`는 일반 stage와 같다. `Running stage cannot be verified stopped`이면 이전 대화를 닫거나 agent가 끝나기를 기다린 뒤 같은 명령을 반복하고, agent가 output을 이미 썼다는 거부에는 안내된 `finish`를 실행한다. 변경된 project 파일은 사용자에게 보여 주고 commit 또는 stash를 요청한다. 인계 단계만 실행하려면 `harness-prepare-input.mjs --stage-id <stage> --take-over-interrupted true`를 쓰며 출력의 `next`가 이어갈 명령이다.

기존 stage가 `running`으로 남아 사용자 답을 처리할 수 없으면, 답의 원문과 질문 ID를 보존한 채 해당 실행에 `harness-native-stage.mjs inspect --execution-id <execution_id>`를 실행한다. 반환된 실제 `agent_id`로 현재 CLI의 서브에이전트 상태와 결과를 확인한다. 아직 실행 중이면 그 agent를 기다린다. 완료 결과가 있으면 기존 실행의 `finish`를 먼저 호출한다. `output.json`이 누락된 Codex 작업자는 등록된 orchestrator 대화에서 `receive_command`를 표준 입력 없이 실행해 완료 turn의 단일 JSON 객체를 복구할 수 있다. `received` 또는 `already_received`가 반환되면 `finish`를 호출한다. 다시 제출해야 할 때는 `inspect`가 반환한 `schema_path`와 `receive_command`를 같은 에이전트에게 보낸다. 실제 실패가 확인되면 오류 원문으로 `fail`을 기록한다. 이전 실행에서 두 차례 `FORMAT_ERROR`가 났고 작업자 종료와 결과 누락을 확인했으며 현재 CLI에서 같은 작업자에게 다시 전달할 수 없으면, 사용자가 재개를 승인한 경우 그 오류를 사유로 `fail`을 기록한다. 같은 stage만 `--feedback`으로 시작해 기존 답변과 산출물을 이어받는다. 검증된 현재 질문이 답을 기다리면 실제 답을 `--answer`로 전달한다. 실패한 실행에 대기 질문이 없으면 기존 입력·결과·답변을 보존하는 `--feedback` 재개에 실제 오류와 사용자의 답 원문을 전달한다. 질문이 이미 답변된 경우에는 중복 전달하지 않는다. 에이전트 상태를 확인할 수 없으면 상태 파일을 임의로 변경하거나 새 실행을 시작하지 않는다.

`inspect`의 `thread_id`는 Codex 부모 session의 실제 시작 기록이 하나로 확인될 때만 제공된다. 현재 CLI가 해당 스레드의 상태 조회를 지원하면 이 ID와 부모 session을 함께 대조한다. `observation`은 현재 worktree와 부모 session에 연결된 hook의 최근 시작·종료 관찰이다. 어느 값도 단독으로 조회 시점의 실시간 에이전트 상태나 성공·실패 판정은 아니며, 중복 또는 늦게 도착한 hook이 있을 수 있다. 현재 CLI의 native 도구가 실제 종료를 확인하기 전에는 이 값만으로 실행을 실패 처리하거나 재개하지 않는다.

대상 ID와 현재 상태가 포함된 native 완료·실패·질문 통지를 사용한다. Codex 대기 도구가 ID를 받으면 bind된 ID로 기다린다. 타임아웃이나 빈 알림이면 다시 기다린다. 대상 통지에 상태가 없거나 재개 직후 확인이 필요하면 대상에 한해 `inspect --execution-id <execution_id>`를 한 번 실행한다. 이미 본 상태를 같은 조건에서 다시 조회하지 않는다. 같은 부모 대화에서 도구가 대상 상태를 따로 제공하지 않고 `inspect`에도 확인 근거가 없을 때만 `collaboration.list_agents` 한 번과 아래 reconcile 절차를 사용한다. `running`·`active`는 추가 통지를 기다린다. 실제 완료는 `finish`, 실제 실패는 오류 원문으로 `fail`을 실행한다. `notLoaded`·누락·다른 호스트의 응답은 종료 근거가 아니다. Claude도 해당 Agent의 현재 task 결과를 사용한다. 과거 통지와 hook 관찰만으로 같은 Agent의 재개 여부나 현재 종료를 추정하지 않는다.

재개 시 다음 동작이 불명확하거나 기존 agent 상태를 복구해야 하면 `harness-context.mjs`를 한 번 실행한다. 원래 Codex 부모 대화의 현재 native stage가 `running`이고 해당 자식 transcript에서 중단이 확인되며 반환 파일이 없으면, 실행기가 `failed/EXECUTION_ERROR`를 기록하고 이전 입력과 사용자 답변을 이어받는 재실행 명령을 `next`로 반환한다.

원래 Codex 부모 대화에서 `collaboration.list_agents`를 호출할 수 있으면, 그 도구의 실제 JSON 응답이 있을 때만 객체 전체를 수정하지 않고 표준 입력으로 `node .harness/scripts/harness-native-stage.mjs reconcile --execution-id <execution_id>`에 전달한다. 준비기는 저장된 agent ID와 현재 부모 session을 대조하고, 종료 상태는 해당 자식의 마지막 turn 기록과 일치할 때만 반영한다. 목록에서 agent가 사라졌어도 일치하는 자식 transcript의 마지막 turn이 `interrupted`로 확인되면 실행기를 통해 실패로 기록한다. `running`이면 해당 agent를 기다리고, `unknown`이면 추측하거나 중복 실행하지 않는다. `completed`의 결과는 기존 `finish`와 같은 형식·보안 검증을 거치며, 실제 `failed` 또는 `interrupted`는 실패 사유를 기록한다. 유효한 output 파일이 없는 읽기 전용 agent는 host의 완료 응답 원문을 출력으로 사용한다. 형식 오류는 같은 agent에게 반환해 수정하게 한다. 사용자가 중단한 경우 `reconcile`로 재개하지 말고 실제 종료를 확인한 뒤 `cancel`을 사용한다. 다른 세션에서 host 목록을 만들거나 응답을 지어내지 않는다.

## 결과 처리

`finish` 성공은 형식 검증 후 정본 결과를 기록한다. 보안 경계, workspace·실행 ID, 실제 승인과 결과 참조의 검증은 그대로 적용한다. 반환된 status와 code에 따라 사용자 질문·리뷰·다음 stage로 전환한다. 질문의 원문과 실제 사용자 답을 보존한다. 사용자 요청으로 중단된 경우 늦게 도착한 결과로 진행을 재개하지 않는다.

실패나 사용자 답변 뒤 새 실행을 예약하면 새 작업자가 이전 결과와 입력을 참조한다. 실행이 유지되는 형식 수정과 컨텍스트 압축은 기존 작업자에게 전달한다. 다른 CLI의 세션 ID를 넘기지 않는다. 단계별 독립 리뷰와 실제 E2E의 별도 승인 및 역할 요구사항은 해당 GUIDE를 따른다.

사용자가 완료된 `to-ticket` 산출물이나 요구사항·전술 설계 stage의 문서를 고치라고 지시하면 `harness-prepare-input.mjs --feedback <사용자 지시 원문> --user-revision true`로 준비한다. 뒤 stage의 대기 질문은 그 지시로 대체되며 사용자 지시를 agent 판단으로 만들어 내지 않는다. 요구사항 수정은 가장 앞선 소유 stage에서 시작한다. 업무 발굴·범위 누락은 `subdomain-candidates`, 업무 묶음·서브도메인 분류는 `subdomain-classification`, 규칙·예외·완료 조건은 `requirements-fix`, Context 책임·관계는 `bounded-context`가 맡는다. 시작과 함께 뒤 단계의 영향받는 결과를 `stale`로 기록한다. 기존 문서와 실행 결과를 읽어 보완하고 `bounded-context`가 완료되면 현재 요구사항을 사용자에게 다시 보여 주고 승인받는다.

실패한 stage와 사용자가 취소한 stage는 실제 종료가 확인된 뒤 같은 stage에 `--feedback`을 전달한다. `REVIEW_REQUIRED`는 실제 독립 reviewer 결과를 `--feedback`으로 돌려준다. 사용자 질문의 답은 실제 답만 `--answer`로 전달하며, 새 실행이 반환한 `answers_path`를 작업자에게 전달한다. 최종 E2E 실패의 구현 수정 승인과 E2E 재실행 승인은 별개다. 검증되지 않은 반환을 성공으로 바꾸거나 기존 상태를 직접 고치지 않는다.

결과가 `SPEC_REVISION_REQUIRED`·`PLAN_REVISION_REQUIRED`·`IMPLEMENTATION_REVISION_REQUIRED`이면 각각 `requirements-fix`·`to-ticket`·영향받는 plan의 `implement-wrapper`를 준비한다. 반환이 지시한 전환에는 `--user-revision`을 붙이지 않는다. 이 옵션은 사용자의 직접 수정 지시에서 사용한다. 반환된 업무 결정만 질문하고, 전술 설계 단계의 범위 추가 질문은 소유 단계에 돌려준다. 제품 문서의 commit은 해당 stage 실행기의 기록을 사용한다.

## 컨텍스트 압축

Codex와 Claude Code의 컨텍스트 압축은 각 native 작업자의 provider가 처리한다. 압축은 stage 전환이 아니다. 같은 실행과 작업자 ID를 유지하고 정상 종료까지 기다린다. 첨부된 산출물이나 사용자 결정을 다시 찾을 때는 해당 작업자의 입력에 있는 참조를 사용한다.

## UI 적용과 보류

승인된 작업 계획에 UI 변경이 없거나 사용자가 이번 실행에서 UI를 보류하면 프런트엔드 스킬을 호출하지 않는다. `tactical-ui`에 근거를 기록한 뒤 API·데이터 설계로 진행한다. 이미 `tactical-ui`가 차단됐으면 사용자의 보류 원문을 `harness-native-stage.mjs launch --stage-id tactical-ui --feedback <사용자 원문>`으로 전달한다. 이미 실행한 `frontend-design-brief`가 기록상 running이면 먼저 `inspect`로 실제 작업자 종료를 확인한다. 중단 또는 실패가 확인되면 기존 절차대로 그 종료를 기록한 뒤 `tactical-ui`로 돌아간다. 보류된 브리프를 복구하거나 결과를 만들어 완료 처리하지 않는다.

UI가 적용되면 확정 요구사항과 Application Service를 기준으로 핵심 화면·흐름을 사용자와 합의한다. 기존 승인 계획에 해당 결정이 있으면 다시 묻지 않는다. `tactical-ui`에 브리프가 필요한 경우 합의한 사용자 답변 원문을 `harness-native-stage.mjs launch --stage-id frontend-design-brief --approval-answer <사용자 원문>`으로 전달한다. `frontend-implementation`과 `frontend-visual-review`는 발행된 `frontend: true` ticket이 준비된 경우에만 실행한다.

## 상위 stage 되돌아가기

stage가 `blocked` / `DEPENDENCY_INCOMPLETE`를 반환하면 `result.owner_stage`(앞 stage 중 빈틈을 소유한 가장 앞 stage)와 `result.dependency_gap`(무엇이 비었는지)이 반드시 있다. `finish`는 이를 검사해 없거나 앞 stage가 아니면 `format_error`로 같은 서브에이전트에 돌려보낸다. 이 block은 사용자 결정이 아니므로 **사용자에게 묻지 않고** 다음 순서로 자동 진행한다. 업무 결정은 이 과정에서도 사용자 질문(`USER_DECISION_REQUIRED`)으로만 오며, orchestrator가 대신 답하지 않는다.

1. `finish`가 출력한 `next`의 명령 `node .harness/scripts/harness-native-stage.mjs launch --stage-id <owner_stage> --reopen-for <blocked execution_id>`를 실행한다. 다른 옵션은 함께 쓰지 않는다. 실행기는 해당 stage의 최신 결과가 `blocked` / `DEPENDENCY_INCOMPLETE`이고 그 `owner_stage`가 요청한 stage일 때만 허용한다(그 뒤 stage가 이미 시작됐거나 발행됐으면 거부).
2. 문서와 산출물은 되돌리지 않는다. owner stage는 `dependency_gap_result` 입력과 gap 설명을 feedback으로 받아 기존 산출물을 앞으로 고친다. owner 뒤에 이미 `completed`였던 stage와 block된 stage는 상태에 `stale`로 기록되어 `completed/OK`로 인정되지 않는다.
3. owner가 완료되면 `finish` 출력의 `next`가 남은 stale stage를 알려 준다. 깨끗한 작업 트리와 정본 결과가 모두 같으면 검증자나 작업자를 다시 호출하기 전에 기존 완료 결과의 stale 표시를 해제한다. 차단됐거나 대기 중인 단계는 이어서 처리한다. 공유 입력이 바뀌었거나 동일성을 확인할 수 없으면 영향받을 수 있는 단계를 유지한다. owner 다음 stage부터 block된 stage까지 `launch --stage-id <stage>`를 순서대로 실행한다(옵션 불필요, 실행기가 "상위가 바뀌었으니 기존 산출물을 갱신하라"는 안내를 자동으로 붙인다). 순서를 어기면 오류가 다음 stage를 가리킨다. `bounded-context` 완료 뒤에는 남은 stale 결과가 있어도 실제 사용자 승인부터 받는다. `tracker-publish`·`tactical-code`는 stale 상태에서 시작할 수 없다.
4. 마지막 전술 설계 stage(`context-boundary`)가 다시 완료될 때 전술 gate가, `tactical-data`가 다시 완료될 때 design-freeze gate가 다시 한 번 실행된다. `to-ticket`이 분할 중 이전 설계의 누락이나 모순을 발견하면 `owner_stage`를 지정한 `DEPENDENCY_INCOMPLETE`로 같은 forward-reopen 절차를 사용한다. 사용자가 이미 확정한 결정을 다시 묻지 않는다.
5. 같은 gap으로 owner를 되돌린 결과가 다시 같은 block이면 새 근거 없이 반복하지 않고 사용자에게 보고한다.

`--restart-requirements true`는 사용자가 명시적으로 롤백을 지시한 경우에만 쓰며 이 경로와 별개다.

### 환경 block 재시도와 범위 축소 지시

- 현재 stage가 `blocked` / `ENVIRONMENT_UNAVAILABLE`이면 사용자에게 기다리라고 하지 않고 `launch --stage-id <그 stage> --feedback '<환경에서 바뀐 것, 그 사이 받은 사용자 지시>'`로 다시 실행한다. stage가 workspace preflight를 다시 실행해 전제를 재확인한다. 같은 원인으로 다시 막힐 때만 사용자에게 보고한다. 이 block 뒤 `STAGE_ORDER`·`PREVIOUS_RESULT_MISSING`·`PREVIOUS_UNRESOLVED`·`USER_REVISION_REFUSED`·`REVISION_TARGET`·`RESTART_REFUSED`·`FEEDBACK_REFUSED`·`REOPEN_REFUSED`·`DISCARD_REFUSED`가 나오면 오류의 `next`가 이 재실행을 가리키며, 다른 stage를 시작하거나 `--user-revision`·`--restart`를 쓰지 않는다.
- 전술 단계에서 사용자가 확정 범위의 축소나 보완을 지시하면 가장 앞선 요구사항 소유 stage를 `--user-revision`으로 다시 연다. 문서와 산출물은 그대로 두고 영향을 받는 부분과 후속 결과를 다시 확인한다.

`DEPENDENCY_INCOMPLETE` block 뒤 `PREVIOUS_RESULT_MISSING`·`RESTART_REFUSED`·order guard·user-revision 거부가 나오면 그 오류의 `next`가 이 경로를 가리킨다. `result.owner_stage`가 있으면 `launch --stage-id <owner_stage> --reopen-for <blocked execution_id>`, 없으면(이전 Harness가 기록한 결과) `launch --stage-id <blocked stage> --feedback 'Re-check the blocker and return owner_stage and dependency_gap naming the earlier stage that must change.'`로 block된 stage를 다시 실행해 owner를 반환받는다. 요약 문장에서 owner를 추정하지 않고, `--user-revision`·`--restart-requirements`를 쓰거나 사용자에게 기다리라고 말하지 않는다.

## Workflow 완료

요청 범위의 마지막 stage가 완료되면 `node .harness/scripts/harness-workflow-complete.mjs --root <workspace_root> --workflow <workflow-id> --worktree-id <worktree.json의 worktree_id> --base-ref <시작 commit SHA> --final-workflow`를 실행한다. `--base-ref`는 workflow를 시작할 때 보존한 `git rev-parse HEAD`다. 계획·발행까지 요청했으면 `to-ticket`, Spec 기반 legacy 구현이면 `implement-wrapper`, 새 전술 설계의 구현까지면 `tactical-to-code`를 지정한다. 중간 완료 gate에는 `--final-workflow`를 붙이지 않는다.

gate는 worktree에 기록된 실행·commit·tracker 상태와 해당 workflow의 리뷰·E2E·계약 근거를 직접 확인한다. 상태 파일을 만들거나 넘기지 않는다. 결과가 `in-progress`이면 `verdict.checks`의 `reason`과 `details`가 가리키는 작업을 처리한 뒤 다시 확인한다. 완료 gate가 통과해야 전체 완료를 보고한다.
