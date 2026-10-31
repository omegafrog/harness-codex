# Workflow 준비

사용자의 최초 요청 원문은 실행 입력의 `scope`에서 읽는다. 준비 명령은 main 브랜치에서 worktree를 만든 뒤 그 안에 입력을 작성한다. 메인 workspace에는 `.io`를 만들지 않는다.

1. 실행 입력의 `context.worktree_ref`로 준비된 정본 `worktree.json`을 읽는다. worktree 준비는 호출자의 `harness-compose-workspace.mjs`가 담당한다.
2. 사용자 요청에 필요한 skill, 단계와 의존 관계를 결정하고 `.codex/internal-skills/workflow-compose/schemas/workflow.schema.json`에 맞는 `runtime/orchestrator/workflow.json`을 실행 session에 작성한다. 기존 파일에 `state`가 있으면 그대로 보존한다.
3. `completed/OK` 반환에 `worktree_ref`와 `request_workflow` artifact (`base: session`, `path: runtime/orchestrator/workflow.json`, `kind: request_workflow`, `sha256: null`)를 포함한다. 실행기가 이 파일에 상태를 추가하므로 변경되는 workflow 파일에 고정 해시를 넣지 않는다. worktree 생성만으로 compose가 완료된 것으로 보고하지 않는다.
4. 호출자는 반환과 workflow를 검증하고 `harness-execution-state.mjs`로 완료 상태를 기록한 뒤에만 다음 세션을 안내한다.

기존 `runtime/orchestrator/workflow.json`을 갱신할 때는 기존 `state` 객체를 그대로 보존한다. 실행기는 compose 시작 시 저장한 상태와 결과의 상태를 비교하고 변경되면 완료를 차단한다. 새 workflow는 실행기가 compose 완료 후 상태를 `created`로 초기화한다. 활성 workflow 변경은 작업 실행 중이 아닐 때만 `harness-compose-workspace.mjs --recompose --worktree-ref <worktree.json> ...`로 준비한다.
