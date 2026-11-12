# 실행 산출물 경로

실행 중 생기는 로그·stdout/stderr 저장본·checkpoint·JSONL·스크린샷·평가 결과·E2E manifest·임시 파일·복구 백업은 절대 `session_directory` 아래에만 쓴다. `/tmp`, 저장소 루트, 임의 외부 경로를 쓰지 않는다.

- caller가 `session_directory`를 전달하지 않았으면 `node .codex/scripts/harness-session-output.mjs --root <workspace_root> [--path <하위 경로>]`로 구한다. 정본 `worktree.json`이 있는 workflow 실행은 그 기록의 `session_directory`를 쓰고 다시 계산하지 않는다.
- 하위 agent/tool에는 `workspace_root`와 `session_directory`를 명시한다. 각 subprocess에 `HARNESS_SESSION_DIR=<session_directory>`와 `TMPDIR`·`TMP`·`TEMP=<session_directory>/tmp`를 전달하고, 서버 로그 redirect와 browser screenshot/trace/download 경로를 `runtime/<작업>/` 아래로 지정한다.
- 출력 위치를 지정할 수 없는 도구는 경계 밖에 산출물이 생기는지 확인하고, 제어할 수 없으면 실행을 멈추고 보고한다.
- 세션 산출물은 로컬 전용이며 commit·push·tracker·PR에 올리지 않는다.
- 승인된 source·Spec·통합 계약·제품 다이어그램·지식 registry는 선언된 프로젝트 경로에 둔다. 이 예외를 로그 출력 경로로 쓰지 않는다.
