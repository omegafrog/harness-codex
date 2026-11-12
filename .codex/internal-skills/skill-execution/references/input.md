# 실행 입력 준비

1. `node "<workspace_root>/.codex/scripts/harness-prepare-input.mjs" --worktree-ref <절대 worktree.json 경로> --stage-id <선택한 stage ID>`로 선택한 단계의 입력 파일을 준비한다.
   보통 `--stage-id`에는 선택한 skill 이름을 그대로 사용한다. 단, manifest가 `pr_author`로 선언한 `plan-pr`와 `integration-pr`는 stage ID를 전달한다. 준비기는 이 두 ID를 등록된 `gh-open-pr` skill로 해석하고 `context.stage_id`는 유지한다. Spec 내부 phase ID(예: `product`, `architecture`)는 독립 실행 stage가 아니므로 전달하지 않는다. stage 재개에 필요한 session ID는 실행 기록에서 읽는다.
2. 최초 workflow 구성은 메인 workspace에서 `node "<source_workspace>/.codex/scripts/harness-compose-workspace.mjs" --root "<source_workspace>" --execution-id <execution_id> --plan-set-id <feature_slug> --request <사용자 요청 원문>`로 준비한다. `feature_slug`는 읽기 쉬운 이름이며 실제 고유 `plan_set_id`는 실행기가 UUID를 붙여 만든다. 이후 단계는 반환된 `worktree_ref`의 정본 ID를 읽는다. 요청 인자는 shell quoting을 적용한다. 이 명령은 worktree를 만들고 입력·검증된 결과·완료 상태를 그 worktree에 기록한다. 반환된 `execution_id`가 이번 입력과 일치하고 반환된 `worktree_ref`가 생성 전 Git worktree 목록에 없음을 확인한다. 지정된 workflow binding과 정본 기록도 대조한다. 이전 실행의 결과를 이번 생성 결과로 사용하지 않는다. setup 출력은 원본 workspace의 `.io`에 둘 수 있다.
3. 대기 중인 내부 작업 요청은 같은 stage에 `--feedback <서브에이전트 직접 위임 요청>`을 전달해 부모 session에서 이어간다. 차단된 stage도 원인이 해소되면 `--feedback <해소 근거>`로 같은 session을 재개한다. 기존 결과와 session을 보존한다.

## 사용자 답변으로 재개

`USER_DECISION_REQUIRED`의 정본 `result.json`에서 현재 `questions`의 실제 `question_id`를 읽고, 각 답을 `question_id`와 문자열 `answer`를 가진 JSON 배열로 전달한다. 질문 제목이나 임의의 업무 키를 ID로 만들지 않는다. 사용자가 선택지에 조건을 덧붙였거나 직접 설명했으면 선택지 ID 대신 사용자의 답 원문 전체를 `answer`로 넘긴다. 예시의 ID는 형식 설명이며 실제 호출에는 현재 결과의 ID를 그대로 사용한다.

```bash
node .codex/scripts/harness-prepare-input.mjs --worktree-ref <절대-worktree.json-경로> --stage-id <stage-id> --answer '[{"question_id":"<현재-질문-ID>","answer":"<사용자가-선택하거나-위임한-답>"}]'
```

한 번에 일부 질문만 답해 `waiting_for_answers: true`가 반환되면 실행하지 않고 남은 질문의 실제 답을 같은 단계에 전달한다. 모든 답이 모이면 반환된 새 `execution_id`의 `answers.json`을 확인하고 `harness-agent-run.mjs`로 해당 provider의 기존 대화를 재개한다. 이전 결과의 ID, 중복 답변이나 임의의 객체 형태를 사용하지 않는다. 추천안은 사용자가 선택했거나 그 선택을 위임한 경우에만 답변으로 사용한다.

“모두 추천” 같은 일괄 답변은 사용자에게 제시된 질문 묶음에만 적용한다. 이후 새 결과의 질문에는 새 사용자 답변이 필요하다. 단, 사용자가 앞으로의 질문에도 적용하도록 명시적으로 위임한 경우에는 그 범위에 따른다.

질문을 반환한 실행의 `decision-answers.json`은 그 질문에 대한 확정 답변이다. 재개 실행의 `answers.json`은 그 실행에 전달된 입력 답변이다. 두 경로를 혼동해 존재하지 않는 파일을 근거로 인용하지 않는다. 수정 반환으로 같은 stage를 재개할 때는 `--feedback`에 구체적인 수정 지적을 전달할 수 있으며, 원래 provider와 session을 유지한다.
