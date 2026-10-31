# 시작 hook의 상태 확인

`harness-orchestrator-hook.mjs`의 시작 상태 검사는 읽기 전용으로 현재 Git root·common directory와 `git worktree list --porcelain -z`를 조회한다. 같은 저장소의 canonical session 디렉터리에서 `worktree.json`·`runtime/orchestrator/workflow.json`의 `state`을 읽고 실제 등록 경로·branch·디렉터리 존재 여부와 대조한다. 조회 과정에서 기록을 생성·이전·복구하거나 worktree를 제거하지 않는다.

## 판정 힌트

| `decision_hint` | 관측된 상태 | 메인 세션의 처리 |
|---|---|---|
| `resume_candidate` | 현재 저장소의 canonical session 기록에 진행 중 workflow 또는 생성 중 작업이 있음 | `handoff_required`가 참이면 `handoff_workspace` 절대 경로를 사용자에게 반환하고 원본 세션을 중단한다. 거짓이면 현재 Git root가 정본 worktree와 일치하는지 검사한 뒤 workflow의 다음 실행 가능한 stage를 선택한다. |
| `compose_candidate` | 현재 root가 primary이고 관련 진행 기록이 없거나 같은 세션의 workflow가 종료됨 | 실제 새 작업 요청인 경우에만 workflow-compose를 호출한다. |
| `inspect_required` | 소유권 없는 linked worktree, 경로·branch 불일치, 손상·누락·중복 기록 등 | 원인을 확인하고 기존 기록을 보존한다. 자동 재생성·복구는 하지 않는다. |

시작 상태의 `handoff_required`와 `handoff_workspace`는 원본(primary) 프로젝트 세션에서 이미 완료된 Compose의 신규 Worktree를 발견했을 때만 설정한다. 이 경우 기존 Workflow를 이어서 실행하지 않고 사용자에게 새 Codex 세션에서 재호출하도록 안내한다. 사용자가 Worktree 안에서 재호출하면 이 값은 false가 되며 Workflow의 `stages` 및 `state`를 이용해 실행 가능한 Skill을 선택한다.

workflow state는 현재 저장소의 canonical session 경로와 검증된 worktree 기록으로 식별한다. hook이 전달한 `orchestrator_session_id`와 `agent_sessions`는 기존 대화를 이어갈 Codex session ID다. orchestrator는 stage/subtask별 마지막 ID를 `harness-static-call.mjs --resume`에 전달해 해당 worker 대화를 재개한다. `codex_session_id`는 실제 메인 대화의 ID이며 worktree 소유권을 결정하지 않는다. 다른 Git common directory의 기록은 찾지 않으며, 같은 저장소에 활성 workflow가 여러 개면 임의로 고르지 않고 `inspect_required`로 반환한다. 최종 새 작업/재개 결정은 메인 orchestrator가 맡는다.

## Orchestrator 상태 기록

상태 파일 쓰기는 `harness-execution-state.mjs`가 담당한다. 단계 시작 전에 running을 기록하고 결과 검증 후 반환 상태를 기록한다. 프로세스·검증 실패도 failed로 기록하며 기록 실패는 다음 단계를 차단한다. 개별 단계 완료는 전체 workflow 완료가 아니므로 전체 상태는 waiting으로 둔다. `worktree.json.agent_sessions`는 `orchestrator`와 각 stage/subtask별 마지막 Codex session ID 및 execution ID를 보존한다. `codex_session_id`에는 최근 실제 메인 hook ID를 남긴다. 임의 ID나 worktree ID를 넣지 않는다.

```json
{
  "schema_version": 1,
  "codex_session_id": "<hook이 전달한 실제 Codex session ID>",
  "status": "running",
  "current_stage": "product-review",
  "workflow_ref": "runtime/orchestrator/workflow.json"
}
```

`status`는 `created`, `running`, `waiting`, `blocked`, `completed`, `cancelled`, `failed` 중 하나다. workflow-compose 실행기가 시작할 때는 `current_stage: "workflow-compose"`, `workflow_ref: null`로 기록하고 실제 agent ID·execution ID를 추가한다. 생성 결과를 채택하면 `workflow_ref`를 채우고 신규 상태는 `created`로 설정한다. 기존 workflow 상태가 있으면 보존한다. 이 과도기에도 hook은 같은 세션의 생성 작업이 있음을 전달하므로 중복 생성하지 않는다. 상태 질문이나 사용자 답변을 받으면 기존 기록을 갱신한다.

상태가 없는 workflow 파일은 기존 기록으로 간주하지 않는다. `codex_session_id`가 없거나 이전 세션 ID인 상태도 현재 저장소·workflow reference·worktree 기록이 유효하면 이어갈 수 있다. Hook은 `matching_workflows`, `worktrees`, `issues`의 실제 경로를 함께 전달하며 많은 worktree가 있으면 표시 개수와 생략 개수를 구분한다.

## 진행 상황 집계

실행기는 단계 실행 결과에 따라 `workflow.json`의 `state.stages` 객체에 workflow stage ID별 `{ "status": "pending", "execution_id": null, "result_ref": null, "reason": null }`를 기록한다. 상태는 `pending`, `running`, `waiting`, `blocked`, `completed`, `failed`, `cancelled`, `skipped`다. dispatch 전에 running, 검증된 반환과 gate 판정 후 해당 상태로 갱신한다. 재시도는 같은 stage를 running으로 되돌리고 새 execution ID를 기록한다. 조건상 생략은 skipped와 사유를 남긴다. 병렬 단계도 각각 기록하며 `current_stage` 하나로 완료 여부를 추측하지 않는다.

`UserPromptSubmit`, `PostToolUse`, `Stop` hook은 같은 Codex 세션의 기록으로 `<session_directory>/runtime/orchestrator/progress.json`을 원자적으로 갱신한다. 이 파일은 workflow ID, 전체 상태, 현재 단계, stage별 상태·실행 ID·결과 참조·차단 사유, 상태별 개수, 완료 단계 비율, 관측 시각·event를 담는다. 진행률은 완료 단계 수/전체 단계 수이며 시간·작업량 추정치가 아니다. workflow 생성 중에는 전체 단계 수 0, 비율 null이다. 기존 stage 기록이 없으면 pending으로 표시한다. hook은 단계 전환이나 성공 판정을 만들지 않는다. 상태 질문에는 이 집계와 원본 state·결과 파일을 함께 읽는다. 갱신 시각 이후 hook이 실행되지 않았다면 최신 상태라고 단정하지 않는다.
