# 설정 선택


1. `harness-session-output.mjs --root <absolute-project-root>`로 session directory를 구한다. 새 setup 요청마다 그 안에 새 UUID를 사용한 `runtime/setup/<setup-id>/answers.json`을 만들고 `{"answers":{}}`로 시작한다. 이전 실행의 답변 파일을 읽거나 덮어쓰지 않는다. 같은 setup의 질문을 이어갈 때만 이 파일을 사용한다.
2. 같은 cwd에서 `node .codex/scripts/harness-setup.mjs --root <absolute-project-root> --answers <해당 setup의 절대 answers.json 경로>`를 실행하고 프로세스 종료를 기다린다. 기존 설정이 있으면 CLI가 현재 설정을 재사용할지 새로 설정할지 먼저 묻는다. 재사용을 선택하면 유효한 값은 유지하고 누락·오류 항목만 확인한다. `status: configured`만 적용 완료다.
3. `status: needs_input`이면 `questions` 배열을 읽는다. 아직 답이 없는 질문 전체가 묻는 순서대로 들어 있고 각 질문은 `id/prompt/type/options/current/context`를 가진다. `pending`은 첫 질문과 같은 호환용 필드이므로 쓰지 않는다. `request_user_input_async({"questions":[{"title":"질문 전체와 필요한 context","options":["선택지 label"]}, ...]})`의 `questions`에 배치 전체를 한 번에 담아 한 화면에서 받는다. CLI의 질문 객체를 그대로 전달하지 않는다. `title`에 prompt와 필요한 context를 넣고 options 객체는 label 문자열 배열로 바꾼다. text 입력은 options를 생략한다. 실제 사용 가능한 도구가 없으면 중단하며 PTY나 별도 창으로 우회하지 않는다.
4. `depends_on`이 있는 질문은 나열된 선행 질문의 답에 따라 선택지나 존재가 바뀔 수 있다. CLI가 선행 질문의 `current`(없으면 첫 선택지)를 임시 답으로 삼아 만든 질문이다. 같은 화면에 함께 보여 주고 `title`에 "선행 질문의 답을 바꾸면 다시 묻는다"고 알린다. 마지막 확인 질문(`이 설정으로 계속할까요?`)은 이 배치에서 고른 답으로 설정을 적용한다는 뜻이며, 그 요약은 모든 답을 받은 뒤에만 정해진다.
5. `{ "accepted": true }`는 질문 접수일 뿐 답변이 아니다. 실제 응답을 기다려 모든 label을 해당 value로 매핑하고 `answers[question.id]`에 한꺼번에 저장한 뒤 2를 다시 실행한다. 이전에 저장한 답은 지우지 않는다. 기본값·권장값·사전 선택을 제출로 취급하지 않는다. 사용자 답을 추정하지 않으며 일부 질문만 답한 채 실행하지 않는다.
6. 다시 `needs_input`이 오면 새 `questions`만 같은 방식으로 묻는다. 이번에 돌아온 질문은 아직 답이 없는 질문과, 선행 답이 바뀌어 이전 답이 더 맞지 않는 질문(`previous_answer`가 있는 질문, 예: provider를 바꾼 뒤의 모델·effort 질문)뿐이다. 마지막 확인 질문은 답이 새로 필요한 질문이 있는 동안 함께 다시 온다. 이미 유효한 답은 다시 묻지 않는다.
7. CLI는 실제 Codex app-server의 live model/effort와 프로젝트 상태에서 질문을 만들며 유효하지 않은 선택을 거부한다. 답을 기다릴 때는 실제 native UI 요청을 유지하며 “터미널이 입력 대기 중”이라는 보고만 남기고 종료하지 않는다. 사용자 취소/무응답은 적용 승인이 아니다.
8. `status: configured`와 exit 0을 받은 뒤 초기 기준 commit 준비로 이어간다. `needs_input`과 exit 0은 아직 받아야 할 질문이 있다는 뜻이며 모든 답이 있을 때까지 설정은 어떤 파일도 쓰지 않는다. CLI 오류는 원문과 종료 코드를 보고하고 사용자에게서 받은 중단 조건을 따른다. 일반적인 terminal CLI는 수동 사용을 위해 유지하되 `$setup`은 이 native UI 경로만 사용한다.

CLI는 선택지 발견·검증·설정 적용을 소유하고 스킬은 native UI 전달만 맡는다. 프로젝트 기존 파일은 보존한다. `observability.victorialogs.local.enabled: true`이면 설치된 `victorialogs-local-setup`을 이어 실행해 OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics·공식 MCP 두 개와 실제 앱 개발 profile을 연결한다. 앱 기준 metrics_url과 컨테이너 기준 scrape_url을 구분하고 포트를 추정하지 않는다. GUI·숨은 PTY나 별도 설치 절차를 요구하지 않는다.
