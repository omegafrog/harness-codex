# 실행 입력 준비

compose 명령에는 실제 `--orchestrator-provider <provider>`와 `--orchestrator-session-id <session-id>`를 함께 전달한다. 생성 성공 후 절대 workspace 경로를 사용자에게 알리고 primary checkout에서 멈춘다. 사용자가 해당 worktree로 이동해 orchestrator를 다시 호출하면 stage를 진행한다. 입력 준비와 상태 조회는 현재 worktree에서 `node .codex/scripts/harness-native-stage.mjs launch --stage-id <stage>`와 `node .codex/scripts/harness-context.mjs`로 실행한다. primary checkout에서 `--root`나 `--worktree-ref`로 다른 workflow를 고르지 않는다.

1. target worktree로 이동한 뒤 `node .codex/scripts/harness-native-stage.mjs launch --stage-id <선택한 stage ID>`로 입력 파일을 준비하고 실행을 예약한다. 입력만 준비하려면 같은 옵션으로 `node .codex/scripts/harness-prepare-input.mjs`를 실행한다. 출력은 `execution_id`·`stage_id`·`next`만 담으며 저장된 입력 전체는 `--verbose`로만 출력한다.
   보통 `--stage-id`에는 선택한 skill 이름을 그대로 사용한다. 단, manifest가 `pr_author`로 선언한 `plan-pr`와 `integration-pr`는 stage ID를 전달한다. 준비기는 이 두 ID를 등록된 `gh-open-pr` skill로 해석하고 `context.stage_id`는 유지한다. Spec 내부 phase ID(예: `product`, `architecture`)는 독립 실행 stage가 아니므로 전달하지 않는다. stage 재개에 필요한 session ID는 실행 기록에서 읽는다.
2. 최초 workflow 구성은 메인 workspace에서 `node "<source_workspace>/.codex/scripts/harness-compose-workspace.mjs" --root "<source_workspace>" --execution-id <execution_id> --plan-set-id <feature_slug> --request <사용자 요청 원문>`로 준비한다. `feature_slug`는 읽기 쉬운 이름이며 실제 고유 `plan_set_id`는 실행기가 UUID를 붙여 만든다. 이후 단계는 반환된 `worktree_ref`의 정본 ID를 읽는다. 요청 인자는 shell quoting을 적용한다. 이 명령은 worktree를 만들고 입력·검증된 결과·완료 상태를 그 worktree에 기록한다. 반환된 `execution_id`가 이번 입력과 일치하고 반환된 `worktree_ref`가 생성 전 Git worktree 목록에 없음을 확인한다. 지정된 workflow binding과 정본 기록도 대조한다. 이전 실행의 결과를 이번 생성 결과로 사용하지 않는다. setup 출력은 원본 workspace의 `.io`에 둘 수 있다.
3. 대기 중인 내부 작업 요청은 같은 stage에 `--feedback <서브에이전트 직접 위임 요청>`을 전달해 부모 session에서 이어간다. 차단된 stage도 원인이 해소되면 `--feedback <해소 근거>`로 같은 session을 재개한다. 기존 결과와 session을 보존한다.

완료된 요구사항 또는 전술 설계 stage부터 다시 시작하라는 사용자 지시가 있으면 해당 worktree에서 `node .codex/scripts/harness-prepare-input.mjs --stage-id <stage> --restart-requirements true`를 실행한다. 실행기는 깨끗한 worktree, 연속된 해당 plan set의 stage commit과 실행 종료를 확인하고 이전 문서와 상태를 보존한 뒤 선택한 stage 직전으로 되돌린다. 전술 설계 stage를 고르면 `tactical-design.md`(예전 이름 `domain-model.md`를 쓰던 checkpoint는 그 이름으로 복원되고 다음 전술 stage 준비 때 실행기가 다시 `tactical-design.md`로 바꾼다)와 프로젝트 모델 문서만 되돌리고 `requirements.md`에 덧붙은 규칙은 남긴다. 반환된 `backup`을 보존하고 선택한 stage를 일반 절차로 준비한다. 이후 사용자가 지정한 중단 지점에서 멈춘다. 진행 중 agent의 종료가 확인되지 않거나 다른 commit·변경이 있으면 차단하며 수동으로 상태를 고치지 않는다.

요구사항·전술 설계 stage와 `spec-me`는 `PRE_SPEC_STAGES` 순서로만 시작한다. 준비기와 `harness-native-stage.mjs start`는 앞 stage가 모두 `completed/OK`가 아니면 `<stage> cannot start before <앞 stage>`로 거부한다. 오류가 가리킨 앞 stage부터 진행하며 지침이 오래됐다는 이유로 건너뛰지 않는다. 같은 오류가 해당 stage 항목이 결과 없이 `running`·`failed`·`cancelled`로 남았다고 알리면 이전 Harness가 순서를 어기고 시작한 것이다. 그 native 실행이 끝났고 orchestrator Codex session을 닫았다면 해당 worktree에서 `node .codex/scripts/harness-prepare-input.mjs --stage-id <stage> --discard-out-of-order true`를 단독으로 실행한다. 실행기는 종료 증거(bind된 agent의 interrupted·failed 결과, bind되지 않았으면 그 뒤 시작된 subagent가 없고 session을 연 process가 없음, 또는 native runner가 기록한 failed·cancelled)와 깨끗한 project worktree, 그 stage의 commit 부재를 확인한다. 이전 state를 `runtime/restarts/out-of-order-*`에 보존하고 stage 항목을 지워 직전 완료 stage 대기 상태로 되돌린다. 반환된 `previous_stage` 다음 stage를 일반 절차로 준비한다. 종료를 확인할 수 없거나 결과가 있거나 순서를 따르는 stage는 거부하며 state를 직접 고치지 않는다.

다른 Codex 대화가 시작했다가 종료된 native stage가 `running`으로 남은 경우의 인계(`--take-over-interrupted true`, 보통은 `launch --take-over true`)는 [실행과 결과](dispatch.md)가 소유한다. 이 옵션도 `--stage-id`와 단독으로만 쓰며 state를 직접 고치지 않는다.

## 사용자 답변으로 재개

`USER_DECISION_REQUIRED`의 정본 `result.json`에서 현재 `questions`의 실제 `question_id`를 읽고, 각 답을 `question_id`와 문자열 `answer`를 가진 JSON 배열로 전달한다. 질문 제목이나 임의의 업무 키를 ID로 만들지 않는다. 사용자가 선택지에 조건을 덧붙였거나 직접 설명했으면 선택지 ID 대신 사용자의 답 원문 전체를 `answer`로 넘긴다. 예시의 ID는 형식 설명이며 실제 호출에는 현재 결과의 ID를 그대로 사용한다.

```bash
node .codex/scripts/harness-native-stage.mjs launch --stage-id <stage-id> --answer '[{"question_id":"<현재-질문-ID>","answer":"<사용자가-선택하거나-위임한-답>"}]'
```

한 번에 일부 질문만 답해 `waiting_for_answers: true`가 반환되면 실행하지 않고 남은 질문의 실제 답을 같은 단계에 전달한다. 모든 답이 모이면 `launch`가 새 실행을 예약해 `answered: true`와 함께 반환하므로 native 서브에이전트를 호출한다. 준비기만 실행했다면 `harness-native-stage.mjs start`로 예약한다. 같은 provider면 기존 대화를 재개하고, 다른 provider면 새 대화에서 이전 결과와 답변을 읽는다. 모든 답이 모이기 전에는 이미 전달한 답을 고칠 수 있다. 같은 `question_id`의 새 답이 이전 답을 대체하며, 한 번의 호출에 같은 ID를 두 번 담지 않는다. 모든 답이 모여 `decision-answers.json`이 기록된 뒤에는 다른 답으로 바꿀 수 없다. 이전 결과의 ID, 중복 답변이나 임의의 객체 형태를 사용하지 않는다. 추천안은 사용자가 선택했거나 그 선택을 위임한 경우에만 답변으로 사용한다.

실행 중 `--answer`가 도착하면 준비기는 질문 ID와 답을 보존하고 `waiting_for_running_stage: true`를 반환한다. 새 실행을 만들지 않는다. 기존 에이전트의 실제 종료를 확인하고 `finish` 또는 `fail`을 처리한다. `finish` 결과가 질문 대기이면 `launch --stage-id <stage-id>`를 다시 실행한다. 보존된 답은 해당 질문 ID를 검증해 수집하며 다시 묻지 않는다. 실패 후 재개할 때는 `deferred_user_answers_unverified` 입력으로 보존하며 기존 질문과 대조하기 전에는 적용하지 않는다.

“모두 추천” 같은 일괄 답변은 사용자에게 제시된 질문 묶음에만 적용한다. 이후 새 결과의 질문에는 새 사용자 답변이 필요하다. 단, 사용자가 앞으로의 질문에도 적용하도록 명시적으로 위임한 경우에는 그 범위에 따른다.

질문을 반환한 실행의 `decision-answers.json`은 그 질문에 대한 확정 답변이다. 재개 실행의 `answers.json`은 그 실행에 전달된 입력 답변이다. 두 경로를 혼동해 존재하지 않는 파일을 근거로 인용하지 않는다. 수정 반환으로 같은 stage를 재개할 때는 `--feedback`에 구체적인 수정 지적을 전달한다. 같은 provider는 session을 재개하고 다른 provider는 새 session에서 이전 결과를 읽는다.
