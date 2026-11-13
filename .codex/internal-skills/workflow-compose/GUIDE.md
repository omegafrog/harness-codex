---
model_tier: low_performance
---
# Workflow 준비

setup이 준비한 main의 기준 commit에서 `harness-compose-workspace.mjs`로 worktree를 생성하고 준비 상태와 결과를 검증·기록한다. 준비 명령의 입력은 원본 요청과 실행 식별자이며, worktree 참조는 생성 후 산출물이다. setup의 session 출력은 원본 workspace에 둘 수 있으며 compose 실행 입력은 새 worktree에 기록한다.

사용자가 기존 후보 대신 새 workflow를 선택한 경우에도 위 생성 명령을 새로운 execution ID로 호출한다. 생성 직전 Git에 등록된 worktree 목록을 확인하고, 이번 명령이 직접 반환한 `execution_id`와 `worktree_ref`가 입력 및 결과 기록과 일치하며 반환된 worktree가 생성 전 목록에 없음을 확인한다. 환경에 `HARNESS_WORKFLOW_BINDING`이 지정됐다면 반환된 정본 `worktree.json`의 binding이 같은지도 확인한다. 기존 결과 파일만 읽어 새 생성으로 처리하지 않는다. 불일치나 생성 실패는 그대로 보고하고 기존 worktree를 보존한다.

선택적으로 `HARNESS_WORKFLOW_BINDING='{"provider":"codex","model":"gpt-6-luna","reasoning_effort":"medium"}'`를 메인 orchestrator 실행 환경에 지정할 수 있다. compose는 이를 정본 `worktree.json`에 기록하고 모든 stage와 재개에 적용한다. 생략하면 프로젝트의 `.codex/harness.yaml` binding을 사용한다. binding의 provider는 setup이 정한 `agents.provider`와 같아야 하고 model도 그 provider의 모델이어야 한다. 다르면 compose가 worktree를 만들기 전에 거부하므로, 다른 provider로 실행하려면 먼저 setup을 그 provider로 다시 실행한다. 한 workflow에서 provider를 섞지 않는다.

`--plan-set-id`에는 사람이 읽을 feature slug를 전달한다. compose 실행기는 slug에 UUID를 붙여 고유한 `plan_set_id`를 만들고 정본 `worktree.json`에 저장한다. 이후 단계는 입력 slug를 재사용하지 않고 반환된 worktree 참조의 정본 ID만 사용한다.

compose에는 현재 메인 대화의 실제 provider/session을 `--orchestrator-provider`와 `--orchestrator-session-id`로 전달한다. 실행기는 그 worktree의 기존 `agent_sessions.orchestrator`에 결과 수신 세션을 기록한다. ID를 추측하거나 별도 연결 파일을 만들지 않는다.

명령이 `completed / OK`와 유효한 `worktree_ref`를 반환하면 정본 worktree와 binding을 검증하고 절대 workspace 경로를 사용자에게 돌려준다. primary checkout에서는 첫 stage를 준비·실행하지 않는다. 사용자가 해당 workspace로 이동해 같은 대화에서 orchestrator를 다시 호출하면 그 안에서 첫 stage를 선택·준비·실행한다. 사용자가 cd나 orchestrator 재호출을 하지 않고 main에서 답을 보내면 해당 workflow에는 기록하지 말고 workspace 이동을 안내한다.

여러 worktree는 각자의 `.io` 상태·stage 대화·검증을 사용한다. 결과 알림은 `worktree_ref`와 execution ID로 대상을 식별하지만, 해당 workflow의 답변·재개·다음 stage는 그 worktree를 현재 디렉터리로 둔 대화에서만 처리한다. compact 후에는 현재 디렉터리의 Git 등록과 정본을 다시 읽는다. 전역 current-worktree 선택은 두지 않는다.
