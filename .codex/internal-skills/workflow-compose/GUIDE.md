# Workflow 준비

setup이 준비한 main의 기준 commit에서 `harness-compose-workspace.mjs`로 worktree를 생성하고 준비 상태와 결과를 검증·기록한다. 준비 명령의 입력은 원본 요청과 실행 식별자이며, worktree 참조는 생성 후 산출물이다. setup의 session 출력은 원본 workspace에 둘 수 있으며 compose 실행 입력은 새 worktree에 기록한다.

사용자가 기존 후보 대신 새 workflow를 선택한 경우에도 위 생성 명령을 새로운 execution ID로 호출한다. 생성 직전 Git에 등록된 worktree 목록을 확인하고, 이번 명령이 직접 반환한 `execution_id`와 `worktree_ref`가 입력 및 결과 기록과 일치하며 반환된 worktree가 생성 전 목록에 없음을 확인한다. 환경에 `HARNESS_WORKFLOW_BINDING`이 지정됐다면 반환된 정본 `worktree.json`의 binding이 같은지도 확인한다. 기존 결과 파일만 읽어 새 생성으로 처리하지 않는다. 불일치나 생성 실패는 그대로 보고하고 기존 worktree를 보존한다.

선택적으로 `HARNESS_WORKFLOW_BINDING='{"provider":"codex","model":"gpt-6-luna","reasoning_effort":"medium"}'`를 메인 orchestrator 실행 환경에 지정할 수 있다. compose는 이를 정본 `worktree.json`에 기록하고 모든 stage와 재개에 적용한다. 생략하면 프로젝트의 `.codex/harness.yaml` binding을 사용한다. binding의 provider는 setup이 정한 `agents.provider`와 같아야 하고 model도 그 provider의 모델이어야 한다. 다르면 compose가 worktree를 만들기 전에 거부하므로, 다른 provider로 실행하려면 먼저 setup을 그 provider로 다시 실행한다. 한 workflow에서 provider를 섞지 않는다.

`--plan-set-id`에는 사람이 읽을 feature slug를 전달한다. compose 실행기는 slug에 UUID를 붙여 고유한 `plan_set_id`를 만들고 정본 `worktree.json`에 저장한다. 이후 단계는 입력 slug를 재사용하지 않고 반환된 worktree 참조의 정본 ID만 사용한다.

명령이 `completed / OK`와 유효한 `worktree_ref`를 반환하면 사용자가 해당 worktree에서 새 메인 Codex 세션을 열어 orchestrator를 재개하도록 안내한다. Codex는 세션 안에서 workspace를 바꿀 수 없어서 세션을 새로 연다. 그 worktree에서 orchestrator에게 프롬프트를 보낸 세션이 Harness hook으로 `worktree.json`의 `agent_sessions.orchestrator`에 기록되고, 이후 stage 결과는 그 세션으로 전달된다. 후속 stage 선택은 새 세션의 orchestrator가 담당한다.
