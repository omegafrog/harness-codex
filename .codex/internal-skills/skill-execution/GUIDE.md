# Skill 실행 계약

workflow 최상위 orchestrator는 현재 메인 세션에서 실행한다. 최초 요청의 시작 hook을 받아 [workflow-compose](../workflow-compose/GUIDE.md)를 subagent로 호출하고, 반환된 요청별 workflow를 검증한 뒤 작업 skill을 실행한다. 기존 workflow 파일은 진입 전제가 아니다. orchestrator는 작업 호출과 다음 단계·회귀·재시도·사용자 질문을 결정하고, 실행기는 model·effort 해석과 프로세스 실행을 담당한다. 하위 skill의 agent 호출·리뷰 반복·다른 skill 전환 지시는 메인 세션에 실행 요청으로 반환한다.

## 모델 바인딩

먼저 `node .codex/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill <skill-id> [--workflow <workflow-id> --stage <stage-id>]`으로 실제 `model`, `reasoning_effort`, `model_tier`를 얻는다. 기본 tier와 설정 키는 [bindings.json](bindings.json)이 소유한다. workflow stage가 주어지면 실제 manifest의 stage skill과 tier를 확인한다. 설정 키 문자열, 부모 모델 상속, 임의 모델 fallback을 사용하지 않는다.

orchestrator는 `node .codex/scripts/harness-skill-exec.mjs --root <workspace_root> --session-directory <session_directory> --input <session-relative input.json> [--workflow <manifest-id> --stage <stage-id>]`으로 새 `codex exec`를 실행한다. 실행기는 실제 model·effort를 binding에서 얻고 `--output-schema`에 공통 return schema를 전달한다. role이 필요하면 `context.role`에 실제 role ID를 넣고 작업 agent가 `.codex/agents/<role>.toml`의 지침을 읽게 한다. 작업은 빈 대화로 시작하고 명령 cwd는 `workspace_root`다. 내장 spawn_agent를 대신 호출하지 않는다. 프로세스 실패·반환 누락·검증 실패는 실행 오류로 남기며 정상 결과로 대체하지 않는다.

입력의 `shared_guidance_root`는 `workspace_root`와 같은 Git common directory인지 검증한다. managed linked worktree에서 worker를 실행할 때는 검증된 원본 프로젝트 경로와 해당 worktree의 canonical session directory만 추가 `--add-dir`로 허용한다. 전체 `.git` 또는 다른 Git metadata 경로는 worker에 열지 않는다.

실행기는 input 객체를 Codex 세션 메시지에 직접 전달하고 `codex exec`의 구조화 응답에서 전체 result 객체를 받는다. worker는 `input.json`, `return.json`, `result.json`을 읽거나 쓰지 않는다. 실행기는 반환을 검증한 뒤 기존 recovery/audit 경로에 보존하므로 legacy workflow 기록도 계속 읽을 수 있다. `HARNESS_SKILL_EXECUTION_ID`가 있는 실행은 하위 작업이며 startup hook은 메인 orchestrator를 다시 시작하지 않는다.

고정 effort를 가진 내장 role이 선택된 값과 충돌하면, 같은 역할 지침을 읽는 configurable general agent로 실행한다. 해당 adapter에서 그것도 지원하지 않으면 `MODEL_BINDING_UNAVAILABLE`로 반환한다. skill이 실행 중인 자신의 모델을 바꾸거나 설정 누락을 복구하려고 setup을 자동 호출하지 않는다. 최초 setup처럼 모델 설정 자체가 없는 진입은 현재 세션에서 사용자 선택을 수집하고 설정을 완료한 뒤에만 모델을 지정한 subagent 실행을 시작한다.

## 입력과 저장

입력은 [input.schema.json](schemas/input.schema.json)을 따른다. ticket·plan·axis·fixed point처럼 역할에 필요한 식별자는 `context` 객체에 넣는다. `workspace_root`는 제품 파일을 쓰는 작업 위치이며 `session_directory`는 이 실행의 입력·결과·임시 파일이 저장되는 위치다. linked worktree stage는 worktree의 canonical session directory를 `session_directory`로, workflow state를 소유한 caller session을 `context.control_session_directory`로 전달한다. `input_refs`는 `{ "base": "workspace" | "session" | "control_session", "path": "relative/path" }`다. `session`은 task session, `control_session`은 controller session을 가리킨다. `control_session_directory`가 없으면 두 경로는 같다. Spec·plan·source는 선언된 workspace 경로, 실행 결과·findings·로그는 `<session_directory>/runtime/executions/<execution_id>/`에 저장한다. 별도 worktree의 경로·소유권은 기존 `worktree.json` 계약을 유지한다.

skill은 [result.schema.json](schemas/result.schema.json)에 맞는 전체 result 객체를 JSON 문자열로 직렬화해 공통 envelope의 `result` 필드로 반환한다. runner는 이를 객체로 변환·검사하고 기존 recovery/audit 경로에 보존한다. 다른 agent에 넘기는 결과는 다음 실행의 Codex 세션 메시지에 inline으로 포함하며 `input_refs`에는 실제 산출물 파일만 둔다. Stage dependency 결과는 `context.producer_results`, reviewer handoff는 `context.target_result`·`context.review_result`, subtask handoff는 `context.parent_stage_result`·`context.subtask_result`로 전달한다. 리뷰 snapshot·원본 reviewer ID·checkpoint·실패 이력은 기존 소유 원장과 파일을 참조하며 복제하거나 덮어쓰지 않는다.

runner가 Codex session response의 inline result를 검증하고 recovery 경로에 보존한다. agent는 입력·결과 파일을 쓰지 않는다. runner는 실제 산출물 부재, 다른 저장소 session, 경로 탈출, 식별자 불일치, 잘못된 상태·코드를 차단한다. 결과 저장 실패는 `failed/ARTIFACT_WRITE_FAILED`와 `result_ref: null`로만 반환할 수 있다. 중단으로 반환 자체가 없으면 orchestrator가 실행 상태를 조사해 기록하며 `completed`를 만들지 않는다.

자체 검증 명령은 입력 JSON의 `workspace_root`를 `--root`에, `session_directory`를 `--session-directory`에 그대로 전달한다. `shared_guidance_root`나 메인 저장소에서 다시 계산한 세션 경로를 사용하지 않는다.

## 상태와 코드

| status | 허용 code | 의미 |
|---|---|---|
| `completed` | `OK` | 지정 작업 완료. 다음 단계나 전체 완료를 승인하지 않는다. |
| `action_required` | `REVIEW_REQUIRED`, `SUBTASK_REQUIRED`, `SPEC_REVISION_REQUIRED`, `PLAN_REVISION_REQUIRED`, `IMPLEMENTATION_REVISION_REQUIRED`, `USER_DECISION_REQUIRED` | 상세 결과의 필요 작업을 orchestrator가 판단한다. |
| `blocked` | `ENVIRONMENT_UNAVAILABLE`, `PERMISSION_REQUIRED`, `DEPENDENCY_INCOMPLETE`, `INPUT_MISSING`, `MODEL_BINDING_UNAVAILABLE` | 미충족 전제를 파일에 기록한다. |
| `failed` | `EXECUTION_ERROR`, `INVALID_INPUT`, `ARTIFACT_WRITE_FAILED` | 실행 오류. 동일 입력의 무조건 재시도는 하지 않는다. |
| `cancelled` | `CANCELLED` | 취소와 확보된 증거를 기록한다. |

envelope에는 상세 findings·로그·다음 skill 지시를 넣지 않는다. 예시는 다음과 같다.

```json
{"schema_version":1,"execution_id":"exec-0042","skill":"spec-review","status":"action_required","code":"SPEC_REVISION_REQUIRED","result_ref":"runtime/executions/exec-0042/result.json"}
```


## 실행 상태 자동 기록

`harness-skill-exec.mjs`는 `context.codex_session_id`(메인 hook의 ID)를 진단 metadata로 기록하고 `context.stage_id`와 canonical `workflow_ref`로 단계를 식별한다. workflow state는 `context.control_session_directory`에, stage 실행 파일은 `input.session_directory`에 기록한다. 같은 repository의 canonical session/worktree state는 Codex session ID가 바뀌어도 이어서 사용한다. 실행 전 running, 검증 후 반환 상태, 프로세스·검증 실패 시 failed를 원자적으로 기록하고 즉시 progress를 갱신한다. 기록 잠금 충돌·이미 실행 중인 stage·workflow reference 불일치·기록 실패는 실행을 차단한다. 개별 단계 완료는 전체 workflow 완료를 의미하지 않는다. 메인 세션과 worker는 `state.json`을 직접 편집하거나 별도 기록 agent를 호출하지 않는다. CLI는 workspace-write sandbox와 명시적인 session 출력 쓰기 경로로 실행한다.


## Workflow stage 직접 실행

stage가 `SUBTASK_REQUIRED`를 반환하면 inline result의 `details.required_subtasks`에서 실행할 항목의 0부터 시작하는 인덱스를 확인한다. 같은 stage 명령에 `--subtask <index>`를 추가해 내부 skill을 별도 실행한다. 실행기는 부모 결과와 요청을 검증하고 같은 worktree 및 task session을 전달하며 하위 실행을 별도 stage 기록으로 보존한다. 하위 실행이 `completed/OK`이면 반환된 `execution_id`를 같은 stage 명령에 `--subtask-result <execution_id>`로 전달해 부모를 재개한다. 실행기는 부모와 하위 실행의 연결, 요청 skill·role, worktree, 반환 및 산출물을 검증하고 하위 result 객체와 실제 산출물만 전달한다. 재개 worker는 이전 Codex 대화와 `context.parent_stage_result`, `context.subtask_result`를 사용한다. 하위 실행이 실패하거나 추가 결정을 요구하면 부모를 완료로 간주하지 않고 해당 반환을 처리한다. 복수 요청은 의존 순서대로 하나씩 처리하며, 요청에 없는 결과를 임의로 연결하지 않는다.

같은 stage가 질문이나 다른 내부 작업을 거쳐 재개될 때 실행기는 `worktree.json.agent_sessions`에서 해당 stage/subtask의 Codex session ID를 찾아 기존 대화를 재개한다. 이전에 수락한 하위 작업 결과는 다시 검증해 `context.completed_subtasks`에 inline으로 제공한다. worker는 해당 작업의 범위·시점과 현재 요구를 대조해 유효한 결과를 재사용하고 부족한 근거만 요청한다. 이미 완료한 동일 skill·role이 다시 요청된 경우 기존 결과를 inline으로 전달하고, 부족하면 필요한 범위를 명시한다.

내부 작업이 질문을 반환하면 orchestrator는 inline 질문을 확인하고 `--resume-subtask <execution_id> --answer <사용자의 실제 답변>`을 전달한다. `USER_DECISION_REQUIRED`와 리뷰 보고서에 담긴 질문을 같은 방식으로 처리한다. 실행기는 부모와 대기 중인 실행의 연결을 검증하고 기록된 Codex session ID로 `codex exec resume`을 실행해 답변을 직접 전달한다. 답변 파일은 만들지 않는다. 새 결과는 구조화된 세션 응답에서 검증하고, 질문이 반복되면 `worktree.json`의 최신 ID로 같은 절차를 반복한다. 기록된 Codex session ID가 없거나 재개에 실패하면 중단하고 보고한다.

내부 작업이 `REVIEW_REQUIRED`를 반환할 때는 `details.review_request`에 실행할 `skill`, `role`, 검토 범위 `purpose`, 결정 ID·사용자 주장·모드·근거 등 reviewer가 실제로 사용할 `context`를 기록하고 검토 대상 파일을 artifacts로 반환한다. 알 수 없는 입력이나 승인 기록은 만들지 않고 누락을 보고한다. caller는 `--review-subtask <요청 execution_id>`로 fresh reviewer를 실행한다. reviewer는 `context.review_context`와 전달된 artifacts를 직접 읽고 해당 skill의 gate를 적용한다. reviewer가 완료 또는 findings가 담긴 수정·재검토 요구를 반환하면 orchestrator는 결과를 읽고 `--review-subtask <요청 execution_id> --review-result <reviewer execution_id>`로 요청자에게 전달할 수 있다. 실행기는 reviewer와 요청의 연결 및 반환을 검증하고 요청자의 기존 Codex session을 재개해 리뷰 결과를 전달한다. 결과 전달은 리뷰 통과나 사용자 동의를 의미하지 않는다. 기존 기록에 구조화된 요청이 없으면 `--resume-subtask <요청 execution_id> --review-details 1`로 그 세션에 필요한 입력을 명시하도록 요청한다. reviewer가 질문하면 동일한 `--resume-subtask` 질문 절차를 사용한다.

Spec 리뷰 stage는 `harness-spec-review.mjs begin`의 전체 JSON을 제어 session에 보존하고 `--review-admission <session-relative JSON>`으로 전달한다. 실행기는 대상·진행 중 attempt·현재 파일 해시를 검증해 입력에 포함한다. reviewer는 각 workspace 파일을 직접 검토하고 `details.inputs`에 해당 workspace 상대 경로와 해시 전체를 반환한다. session 근거는 별도로 읽으며 해시 맵에 섞지 않는다. 실행기는 반환된 대상과 해시 맵을 admission과 대조한다. 리뷰 기록과 gate는 caller가 담당한다.

구성된 workflow의 단계는 `harness-skill-exec.mjs --root <작업 root> --session-directory <제어 session> --request-workflow runtime/orchestrator/workflow.json --stage <stage-id> --codex-session-id <메인 hook ID>`로 선택한다. 실행기가 stage의 skill·scope·role·inputs와 새 execution ID로 입력 파일을 생성한다. 기존 manifest의 `--workflow` 옵션과 혼용하지 않는다. 선행 단계가 완료/생략되지 않았거나 소유 세션이 다르면 실행하지 않는다.

미래 입력 `{from_stage, artifact}`는 선행 단계의 검증된 inline result에서 `artifacts[].kind`가 `artifact`와 같은 항목 하나로 해석한다. 완료된 worker는 선언된 각 `context.outputs[].id`에 대해 같은 `kind`의 artifact를 정확히 하나 반환한다. 추가 파일은 별도 `kind`를 쓰거나 `kind`를 생략한다. 실행기는 완료 결과를 수락할 때 개수를 검증한다. Harness는 내부 복구를 위해 실행 input/result snapshot을 보존할 수 있지만 worker 간 전달은 Codex 대화와 실제 산출물로만 한다. 최초 workflow-compose input도 동일하게 세션 메시지로 전달한다.


## 경로와 문서 탐색의 소유권

각 skill은 진입 context와 입력 참조를 출발점으로 자신에게 필요한 경로와 문서를 찾아 읽는다. 작업 위치·branch·원본 guidance root·출력 위치는 해당 작업의 `worktree.json`과 session 기록에서 확인한다. Spec·plan·review·계약의 위치는 workflow 입력과 담당 skill의 정본 index·원장에서 해석한다. orchestrator에는 작업 선택과 반환 판단에 필요한 참조를 전달하고, 개별 경로 해석과 문서 탐색은 해당 skill이 수행한다.

실행기는 CLI 시작에 필요한 절대 root·제어 session과 입력 참조를 제공한다. skill은 소유 기록으로 실제 작업 위치를 확인하고 이후 명령의 cwd를 지정한다. worktree 준비가 필요한 신규 요청은 workflow-compose가 기존 생성 CLI를 사용한다. 원문·확정 답변의 파일 보존은 입력 처리와 담당 skill의 산출물 절차에서 수행한다. 영향 분석·리뷰 유효성·repair budget·checkpoint·tracker·cleanup은 각각의 담당 skill과 runtime이 처리하고 결과를 반환한다.


## 질문과 답변

exec worker는 사용자 결정이 필요하면 질문을 inline result의 `details.question`에 [question.schema.json](schemas/question.schema.json)에 맞는 객체로 Korean으로 한 번에 하나 기록하고 `action_required / USER_DECISION_REQUIRED`로 반환한다. 질문에는 결정 사항, 구체적 선택지·영향·추천 이유를 담는다. 확정 답변·미결 topic·재개 checkpoint도 inline result에 보존한다. 사용자에게 별도 다운로드 가능한 파일이 필요한 경우에만 이를 실제 artifact로 반환한다.

메인 orchestrator는 inline 질문을 사용자에게 제시하고 실제 답변을 stage 명령의 `--answer <사용자의 실제 답변>`으로 전달한다. 실행기는 대기 중인 실행을 검증하고 질문 ID와 답변을 해당 Codex session에 전달한다. 답변 파일은 만들지 않는다. worker는 이전 대화와 `context.previous_result`, `context.question`을 사용해 다음 질문 또는 작업을 이어간다.
