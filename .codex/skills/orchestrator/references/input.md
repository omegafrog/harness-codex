# 실행 입력 준비

compose 명령에는 `harness-context.mjs --entry`가 확인한 `--orchestrator-provider <provider>`와 `--orchestrator-session-id <session-id>`를 함께 전달한다. 생성 성공 후 절대 workspace 경로를 사용자에게 알리고 primary checkout에서 멈춘다. 사용자가 해당 worktree로 이동해 orchestrator를 다시 호출하면 stage를 진행한다. 입력 준비와 상태 조회는 현재 worktree에서 `node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage>`와 `node .harness/scripts/harness-context.mjs`로 실행한다. primary checkout에서 `--root`나 `--worktree-ref`로 다른 workflow를 고르지 않는다.

1. target worktree로 이동한 뒤 `node .harness/scripts/harness-native-stage.mjs launch --stage-id <선택한 stage ID>`로 입력 파일을 준비하고 실행을 예약한다. 입력만 준비하려면 같은 옵션으로 `node .harness/scripts/harness-prepare-input.mjs`를 실행한다. 출력은 `execution_id`·`stage_id`·`next`만 담으며 저장된 입력 전체는 `--verbose`로만 출력한다.
   보통 `--stage-id`에는 선택한 skill 이름을 그대로 사용한다. 단, manifest가 `pr_author`로 선언한 `plan-pr`와 `integration-pr`는 stage ID를 전달한다. 준비기는 이 두 ID를 등록된 `gh-open-pr` skill로 해석하고 `context.stage_id`는 유지한다. Spec 내부 phase ID(예: `product`, `architecture`)는 독립 실행 stage가 아니므로 전달하지 않는다. stage 재개에 필요한 session ID는 실행 기록에서 읽는다.
2. 최초 workflow 구성은 메인 workspace에서 `node "<source_workspace>/.harness/scripts/harness-compose-workspace.mjs" --root "<source_workspace>" --execution-id <execution_id> --plan-set-id <feature_slug> --request '<사용자 요청 원문>' --orchestrator-provider <provider> --orchestrator-session-id <session_id>`로 준비한다. `<provider>`·`<session_id>`는 `harness-context.mjs --entry` 출력값이다. 인자는 `--help`로 확인하고 `.harness` 검색이나 CLI 소스 조회로 찾지 않는다. `feature_slug`는 읽기 쉬운 이름이며 실제 고유 `plan_set_id`는 실행기가 UUID를 붙여 만든다. 이후 단계는 반환된 `worktree_ref`의 정본 ID를 읽는다. 반환된 입력·결과 파일은 `refs.*.absolute`로 읽으며 `input_path`는 새 worktree 루트, `result_ref`는 그 `.io` 기준이라 기존 checkout이나 worktree 루트에 붙여 찾지 않는다. 요청 인자는 shell quoting을 적용한다. 이 명령은 worktree를 만들고 입력·검증된 결과·완료 상태를 그 worktree에 기록한다. 반환된 `execution_id`가 이번 입력과 일치하고 반환된 `worktree_ref`가 생성 전 Git worktree 목록에 없음을 확인한다. 지정된 workflow binding과 정본 기록도 대조한다. 이전 실행의 결과를 이번 생성 결과로 사용하지 않는다. setup 출력은 원본 workspace의 `.io`에 둘 수 있다.
3. 대기 중인 내부 작업 요청은 같은 stage에 `--feedback <서브에이전트 직접 위임 요청>`을 전달해 부모 session에서 이어간다. 차단된 stage도 원인이 해소되면 `--feedback <해소 근거>`로 같은 session을 재개한다. 기존 결과와 session을 보존한다.

완료된 요구사항 또는 전술 설계 stage부터 다시 시작할 때 기존 산출물을 수정하는 요청은 [실행과 결과](dispatch.md)의 `--user-revision`을 사용한다. 사용자가 기존 산출물을 이전 상태로 돌리라고 명시했으면 해당 worktree에서 `node .harness/scripts/harness-prepare-input.mjs --stage-id <stage> --restart-requirements true`를 실행한다. 실행기는 깨끗한 worktree, 연속된 해당 plan set의 stage commit과 실행 종료를 확인하고 이전 문서와 상태를 보존한 뒤 선택한 stage 직전으로 되돌린다. 전술 설계 stage를 고르면 `tactical-design.md`(예전 이름 `domain-model.md`를 쓰던 checkpoint는 그 이름으로 복원되고 다음 전술 stage 준비 때 실행기가 다시 `tactical-design.md`로 바꾼다)와 프로젝트 모델 문서, 해당 전술 설계의 클래스 다이어그램을 되돌린다. 확정된 업무 규칙과 ADR은 보존한다. 현재 형식의 검토 전용 stage를 다시 시작하면 검토 결과만 다시 연다. 반환된 `backup`을 보존하고 선택한 stage를 일반 절차로 준비한다. 이후 사용자가 지정한 중단 지점에서 멈춘다. 진행 중 agent의 종료가 확인되지 않거나 다른 commit·변경이 있으면 차단하며 수동으로 상태를 고치지 않는다.

요구사항·전술 설계 stage는 `PRE_SPEC_STAGES` 순서로만 시작하며, `spec-me`는 폐기되어 prepare와 native start에서 거부한다. 준비기와 `harness-native-stage.mjs start`는 앞 stage가 모두 `completed/OK`가 아니면 `<stage> cannot start before <앞 stage>`로 거부한다. 오류가 가리킨 앞 stage부터 진행하며 지침이 오래됐다는 이유로 건너뛰지 않는다. 같은 오류가 해당 stage 항목이 결과 없이 `running`·`failed`·`cancelled`로 남았다고 알리면 이전 Harness가 순서를 어기고 시작한 것이다. 그 native 실행이 끝났고 orchestrator Codex session을 닫았다면 해당 worktree에서 `node .harness/scripts/harness-prepare-input.mjs --stage-id <stage> --discard-out-of-order true`를 단독으로 실행한다. 실행기는 종료 증거(bind된 agent의 interrupted·failed 결과, bind되지 않았으면 그 뒤 시작된 subagent가 없고 session을 연 process가 없음, 또는 native runner가 기록한 failed·cancelled)와 깨끗한 project worktree, 그 stage의 commit 부재를 확인한다. 이전 state를 `runtime/restarts/out-of-order-*`에 보존하고 stage 항목을 지워 직전 완료 stage 대기 상태로 되돌린다. 반환된 `previous_stage` 다음 stage를 일반 절차로 준비한다. 종료를 확인할 수 없거나 결과가 있거나 순서를 따르는 stage는 거부하며 state를 직접 고치지 않는다.

다른 Codex 대화가 시작했다가 종료된 native stage가 `running`으로 남은 경우의 (Codex 또는 Claude Code 대화로의) 인계(`--take-over-interrupted true`, 보통은 `launch --take-over true`)는 [실행과 결과](dispatch.md)가 소유한다. 이 옵션도 `--stage-id`와 단독으로만 쓰며 state를 직접 고치지 않는다.

## 사용자 답변으로 재개

질문의 `title`과 선택지 `label`은 원문 그대로 보여 주고, 사용자가 stage의 작업을 보지 못했다고 가정해 `context`(`settled_rules`·`why_now`)와 선택지마다 `consequence`·`effect`·`example`을 빠짐없이 함께 보여 준다. 요약·생략하거나 직접 지은 예시로 바꾸지 않고, 예시는 이해를 돕는 가정일 뿐 요구사항이 아니라고 밝힌다. 질문 도구가 선택지 설명을 받으면 거기에, 받지 못하면 질문 본문에 선택지별로 이어 쓴다. 저장된 이전 질문처럼 이 필드가 없으면 있는 필드만 그대로 보여 준다. `decision_kind: "technology"`이면 각 선택지의 `evidence`에 있는 기준·판정·출처 제목·URL·확인일을 함께 보여 준다. `decision_kind: "visual_direction"`이면 질문 UI가 이미지를 표시하지 못하므로 질문 전에 `title`의 비교 페이지 절대 경로와 선택지별 `previews`(viewport·caption·session 기준 경로를 `<workspace>/.io/` 아래 절대 경로로 바꾼 값)를 열 수 있는 링크로 먼저 보여 준다. 이미지를 표시할 수 있는 provider는 각 선택지 옆에 이미지를 함께 보여 준다. 시안을 보여 주지 않고 스타일 선택을 묻거나 대신 고르지 않는다. 오케스트레이터 자신의 보충 설명은 질문과 분리한다.

`USER_DECISION_REQUIRED`의 정본 `result.json`에서 현재 `questions`의 `question_id`를 읽는다. 사용자 메시지가 여러 항목에 답하면, 각 항목에 해당하는 확정된 선택이나 답변 구절을 연결한다. 사용자가 조건을 붙이거나 직접 정한 동작은 뜻을 바꾸지 않고 해당 답변 구절을 `answer`에 전달한다.

답변과 확인 질문을 한 메시지로 받으면 확인 질문에 먼저 대화로 답한다. 요청과 정본 결과를 근거로 설명하며, 추가 결정이 필요한 항목은 확인을 기다린다. 항목의 결정을 내리기 전에 사용자가 설명을 요청했다면 해당 `question_id`에 `clarification`으로 연결하고 응답이 확정된 다른 항목은 `answer`로 전달한다. 설명 요청은 답변이 아니므로 설명한 뒤 같은 맥락과 선택지별 예시를 유지해 다시 묻고, 실제 답을 받기 전에는 stage를 재개하지 않는다. 답변이 확정된 항목에 사용자가 별도 질문을 덧붙인 경우에는 확정 구절만 `answer`에 넣는다. 하나의 ID에는 한 형태만 전달한다. 아래 ID는 예시이므로 실제 호출에는 현재 결과의 ID를 사용한다.

확정 답변을 전달하는 예시

```bash
node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage-id> --answer '[{"question_id":"<현재-질문-ID>","answer":"<사용자가-선택하거나-위임한-답>"}]'
```

확정 답변과 다른 항목의 확인 질문을 함께 전달하는 예시

```bash
node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage-id> --answer '[{"question_id":"<확정된-질문-ID>","answer":"<사용자가-선택하거나-위임한-답>"},{"question_id":"<미결-질문-ID>","clarification":"<사용자의-확인-질문>"}]'
```

`waiting_for_answers: true`이면 남은 `questions`에 대한 사용자 결정을 기다린다. 사용자가 `clarification`을 보낸 항목은 같은 ID에 실제 답을 받으면 재개한다. 이미 전달한 답은 대기 중 보존되며 같은 ID의 새 응답으로 고칠 수 있다. 모든 답이 모이면 `launch`가 새 실행을 예약해 `answered: true`를 반환한다. 준비기만 실행했다면 `harness-native-stage.mjs start`로 예약한다. 새 작업자는 이전 결과와 확정 답변을 읽는다. `decision-answers.json`에 기록된 뒤에는 다른 답으로 바꿀 수 없다. 추천안은 사용자가 선택했거나 그 선택을 위임한 경우에 답으로 사용한다.

실행 중 `--answer`가 도착하면 준비기는 질문 ID와 답을 보존하고 `waiting_for_running_stage: true`를 반환한다. 새 실행을 만들지 않는다. 기존 에이전트의 실제 종료를 확인하고 `finish` 또는 `fail`을 처리한다. `finish` 결과가 질문 대기이면 `launch --stage-id <stage-id>`를 다시 실행한다. 보존된 답은 해당 질문 ID를 검증해 수집하며 다시 묻지 않는다. 실패 후 재개할 때는 `deferred_user_answers_unverified` 입력으로 보존하며 기존 질문과 대조하기 전에는 적용하지 않는다.

“모두 추천” 같은 일괄 답변은 사용자에게 제시된 질문 묶음에만 적용한다. 이후 새 결과의 질문에는 새 사용자 답변이 필요하다. 단, 사용자가 앞으로의 질문에도 적용하도록 명시적으로 위임한 경우에는 그 범위에 따른다.

질문을 반환한 실행의 `decision-answers.json`은 그 질문에 대한 확정 답변이다. 재개 실행의 `answers.json`은 그 실행에 전달된 입력 답변이다. 재개 실행은 답변과 피드백이 있을 때만 `answers_path`·`feedback_path`를 반환한다. 이 절대 경로와 입력에 명시된 참조를 사용한다. 수정 반환으로 같은 stage를 재개할 때는 `--feedback`에 구체적인 수정 지적을 전달한다. 새 작업자가 해당 실행의 입력과 이전 결과를 읽는다.

## 사용자 승인 답변 전달

텍스트로 승인을 받을 때는 승인 질문을 보여 주는 시점에 사용자의 답변 형식도 안내한다. 같은 worktree의 소유 대화에서 Codex는 `$orchestrator <승인 답변>`, Claude Code는 `/orchestrator <승인 답변>`을 독립 메시지로 보내도록 안내한다. 예를 들어 사용자가 `$orchestrator 승인하고 진행`이라고 답하면 `--approval-answer '승인하고 진행'`을 전달한다. 지원되는 질문 도구로 승인받은 경우 도구의 사용자 답변 원문을 전달한다. 실행기는 승인 대상 stage 완료 뒤의 provider 대화 기록과 답을 대조한다.

인정되는 답은 worktree 소유 대화의 provider 기록에 있는 사용자 메시지뿐이다. 그 대화가 승인 gate 이후 새로 받은 `$orchestrator <승인 답변>`(Codex; headless 재개는 `codex exec resume <session-id> '$orchestrator <승인 답변>'`)이나 `/orchestrator <승인 답변>`(Claude Code), 또는 그 대화가 직접 연 질문 도구의 답이다. 호출어 없는 일반 메시지, 외부 제어 대화·wrapper·UI form이 따로 받은 답, orchestrator의 말, 값 없는 flag는 기록되지 않는다. 외부에서 이미 받은 승인은 같은 문구에 호출어를 붙여 소유 대화로 다시 보내고, 호출어 뒤 원문을 `--approval-answer`로 전달한다. 같은 답으로 거부된 명령을 반복하지 않는다.

`approval answer was not recorded` 거부의 `error`는 검색한 transcript, gate 시각 이후의 창, 같은 문구의 후보와 탈락 이유(호출어 없음·gate 이전·다른 디렉터리 등)를 적고 `approval_search`에 같은 내용을 구조화해 담는다. `user_decision`이 인정되는 형식을 알려 주므로 사용자에게 그 형식으로 다시 받는다. 사용자가 이미 같은 문구를 호출어 없이 보냈다면 새 질문 대신 호출어를 붙여 다시 보내 달라고 요청한다.
