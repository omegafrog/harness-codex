# 시작 hook의 상태 확인

`harness-orchestrator-hook.mjs`의 시작 상태 검사는 읽기 전용으로 현재 Git root·common directory와 `git worktree list --porcelain -z`를 조회한다. 같은 저장소의 canonical session 디렉터리에서 `worktree.json`·`runtime/orchestrator/state.json`을 읽고 실제 등록 경로·branch·디렉터리 존재 여부와 대조한다. 조회 과정에서 기록을 생성·이전·복구하거나 worktree를 제거하지 않는다.

## 판정 힌트

| `decision_hint` | 관측된 상태 | 메인 세션의 처리 |
|---|---|---|
| `resume_candidate` | 같은 Codex session ID의 진행 중 workflow 또는 생성 중 작업 | 기록을 먼저 읽고 현재 메시지와 작업의 관계를 판단한다. |
| `compose_candidate` | 현재 root가 primary이고 관련 진행 기록이 없거나 같은 세션의 workflow가 종료됨 | 실제 새 작업 요청인 경우에만 workflow-compose를 호출한다. |
| `inspect_required` | 소유권 없는 linked worktree, 다른 세션의 현재 기록, 경로·branch 불일치, 손상·누락·중복 기록 등 | 원인을 확인하고 기존 기록을 보존한다. 자동 재생성·복구·인계는 하지 않는다. |

다른 worktree의 기록도 같은 Git common directory 아래에서 찾지만, Codex session ID가 다른 workflow를 현재 작업으로 간주하지 않는다. worktree 존재만으로 사용자 메시지의 의미를 알 수 없으므로 최종 새 작업/재개 결정은 메인 orchestrator가 맡는다.

## Orchestrator 상태 기록

상태 파일 쓰기는 `harness-skill-exec.mjs` 실행기가 담당한다. 단계 시작 전에 running을 기록하고 결과 검증 후 반환 상태를 기록한다. 프로세스·검증 실패도 failed로 기록하며 기록 실패는 다음 단계를 차단한다. 개별 단계 완료는 전체 workflow 완료가 아니므로 전체 상태는 waiting으로 둔다. hook 입력의 실제 `session_id`를 아래 `codex_session_id`에 기록한다. 임의 ID나 worktree ID로 대체하지 않는다. lifecycle 정보의 정본은 `worktree.json`이며 이 파일에 복제하지 않는다.

```json
{
  "schema_version": 1,
  "codex_session_id": "<hook이 전달한 실제 Codex session ID>",
  "status": "running",
  "current_stage": "product-review",
  "workflow_ref": "runtime/orchestrator/workflow.json"
}
```

`status`는 `running`, `waiting`, `blocked`, `completed`, `cancelled`, `failed` 중 하나다. workflow-compose 실행기가 시작할 때는 `current_stage: "workflow-compose"`, `workflow_ref: null`로 기록하고 실제 agent ID·execution ID를 추가한다. 생성 결과를 채택하면 `workflow_ref`를 채운다. 이 과도기에도 hook은 같은 세션의 생성 작업이 있음을 전달하므로 중복 생성하지 않는다. 상태 질문이나 사용자 답변을 받으면 기존 기록을 갱신한다.

상태가 없는 workflow 파일이나 session ID가 없는 과거 기록은 소유자를 추측해 이어가지 않는다. 메인 세션이 근거를 확인해 연결한다. Hook은 `matching_workflows`, `worktrees`, `issues`의 실제 경로를 함께 전달하며 많은 worktree가 있으면 표시 개수와 생략 개수를 구분한다.

## 진행 상황 집계

실행기는 단계 실행 결과에 따라 `state.json`의 `stages` 객체에 workflow stage ID별 `{ "status": "pending", "execution_id": null, "result_ref": null, "reason": null }`를 기록한다. 상태는 `pending`, `running`, `waiting`, `blocked`, `completed`, `failed`, `cancelled`, `skipped`다. dispatch 전에 running, 검증된 반환과 gate 판정 후 해당 상태로 갱신한다. 재시도는 같은 stage를 running으로 되돌리고 새 execution ID를 기록한다. 조건상 생략은 skipped와 사유를 남긴다. 병렬 단계도 각각 기록하며 `current_stage` 하나로 완료 여부를 추측하지 않는다.

`UserPromptSubmit`, `PostToolUse`, `Stop` hook은 같은 Codex 세션의 기록으로 `<session_directory>/runtime/orchestrator/progress.json`을 원자적으로 갱신한다. 이 파일은 workflow ID, 전체 상태, 현재 단계, stage별 상태·실행 ID·결과 참조·차단 사유, 상태별 개수, 완료 단계 비율, 관측 시각·event를 담는다. 진행률은 완료 단계 수/전체 단계 수이며 시간·작업량 추정치가 아니다. workflow 생성 중에는 전체 단계 수 0, 비율 null이다. 기존 stage 기록이 없으면 pending으로 표시한다. hook은 단계 전환이나 성공 판정을 만들지 않는다. 상태 질문에는 이 집계와 원본 state·결과 파일을 함께 읽는다. 갱신 시각 이후 hook이 실행되지 않았다면 최신 상태라고 단정하지 않는다.
