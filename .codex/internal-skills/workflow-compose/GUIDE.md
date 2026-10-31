# Workflow 준비

사용자의 최초 요청 원문은 실행 입력의 `scope`에서 읽는다. 준비 명령은 첫 커밋이 없는 main 브랜치에서 프로젝트 파일을 포함하지 않는 빈 초기 커밋을 만든 뒤 worktree를 생성하고 그 안에 입력을 작성한다. Git identity나 commit 실패는 그대로 보고한다. 메인 workspace에는 `.io`를 만들지 않는다.

1. 실행 입력의 `context.worktree_ref`로 준비된 정본 `worktree.json`을 읽는다. worktree 준비는 호출자의 `harness-compose-workspace.mjs`가 담당한다.
2. 정본 worktree 기록과 준비 상태를 확인하고 `completed/OK`에 `worktree_ref`를 반환한다. 단계 선택과 분기는 메인 orchestrator가 담당한다.
3. 호출자는 준비 결과를 검증하고 완료 상태를 기록한 뒤 다음 세션을 안내한다.
