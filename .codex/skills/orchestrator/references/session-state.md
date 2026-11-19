# 실행 상태와 재개

`harness-context.mjs --entry`는 정본 `worktree.json`, `runtime/orchestrator/state.json`, Git worktree 등록 상태를 확인한다. 검증된 현재 대화를 해당 대화의 워크트리에 연결한다. 소유권이나 중복이 불명확하면 진입 결과의 복구 절차를 따른다. 종료된 실행은 보존한다.

실행 상태는 `harness-execution-state.mjs`가 기록한다. 각 stage의 실행 ID, 결과, 상태, 모델, 시도 이력과 현재 stage를 보존한다. `workflow-compose` 완료는 worktree 준비 완료이며 다음 stage를 선택하지 않는다. Orchestrator는 요청 범위와 이전 결과를 보고 스킬을 선택하고, 질문·리뷰·회귀 결과를 해당 스킬의 기존 세션과 산출물에 연결한다.

`progress.json`은 기록된 실행 상태의 읽기 전용 집계다. 실행하지 않은 미래 단계의 수나 진행률은 추정하지 않는다.
