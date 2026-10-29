# Workflow 준비

사용자의 최초 요청 원문을 입력받는다.

1. 실행 입력의 `context.worktree_ref`로 준비된 정본 `worktree.json`을 읽는다. worktree 준비는 호출자의 `harness-compose-workspace.mjs`가 담당한다.
2. 사용자 요청에 필요한 skill, 단계와 의존 관계를 결정하고 `.codex/internal-skills/workflow-compose/schemas/workflow.schema.json`에 맞는 `runtime/orchestrator/workflow.json`을 실행 session에 작성한다. 기존 파일에 `state`가 있으면 그대로 보존한다.
3. `completed/OK` 반환에 `worktree_ref`와 `request_workflow` artifact (`base: session`, `path: runtime/orchestrator/workflow.json`)를 포함한다. worktree 생성만으로 compose가 완료된 것으로 보고하지 않는다.
4. 호출자는 반환과 workflow를 검증하고 `harness-execution-state.mjs`로 완료 상태를 기록한 뒤에만 다음 세션을 안내한다.

기존 `runtime/orchestrator/workflow.json`을 갱신할 때는 기존 `state` 객체를 그대로 보존한다. 새 workflow는 실행기가 compose 완료 후 상태를 `created`로 초기화한다.
