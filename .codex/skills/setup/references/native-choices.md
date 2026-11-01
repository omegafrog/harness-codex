# 설정 선택


1. `harness-session-output.mjs --root <absolute-project-root>`로 session directory를 구하고 그 안의 `runtime/setup/answers.json`을 만든다. 최초 내용은 `{"answers":{}}`이며 이전 사용자 답이 있으면 보존한다.
2. 같은 cwd에서 다음 비대화 명령을 실행하고 해당 프로세스가 종료될 때까지 기다린다. 실행 도구가 진행 중인 session을 반환하면 같은 session을 조회해 종료 코드와 JSON을 수집한다. CLI는 Beads 초기화와 상태 확인을 마친 뒤 설정 적용 결과를 반환한다.

   `node .codex/scripts/harness-setup.mjs --root <absolute-project-root> --answers <session_directory>/runtime/setup/answers.json`

3. 기존에 승인된 설정을 재사용할지 다시 정할지 묻고, 사용자의 답변을 받은 뒤 setup을 시작한다. `status: needs_input`이면 `question.prompt/options/current/context`를 읽는다. 선택 도구에는 `request_user_input_async({"questions":[{"title":"질문 전체와 필요한 context","options":["선택지 label"]}]})` 형식을 사용한다. CLI의 `question` 객체를 그대로 전달하지 않는다. `title`에 prompt와 선택에 필요한 context를 넣고, `options` 객체 배열은 각 항목의 `label` 문자열 배열로 바꾼다. `type: text`는 `options` 없이 `title`만 전달한다. 도구의 실제 availability와 mode 제한을 지키며 지원되지 않는 도구를 호출하거나 mode를 임의 전환하지 않는다. 도구가 없으면 네이티브 UI 미지원 사유를 보고하고 중단하며 PTY/별도 창으로 우회하지 않는다. 선택지가 도구의 표시 한도를 넘으면 페이지를 나누되 실제 선택 항목을 누락하지 않는다.
4. `request_user_input_async`의 `{ "accepted": true }`는 질문 접수 결과이지 사용자 답변이 아니다. 사용자의 실제 응답을 받을 때까지 설정 선택과 실행을 보류한다. 제출된 label을 원래 선택지의 `value`에 정확히 대응시켜 `answers[question.id]`에 기록하고 응답의 `configuration_hash`도 보존한다. `request_user_input`을 사용하면 반환된 실제 선택만 기록한다. 도구의 사전 선택, 권장값, 무응답을 답변으로 간주하지 않는다. AI가 모델·effort·tracker·관측성 값을 임의 선택하지 않는다.
5. 2~4를 반복한다. CLI는 실제 Codex app-server의 live model/effort와 프로젝트 상태에서 질문을 만들며 유효하지 않은 선택·변경된 configuration snapshot을 거부한다. 답을 기다릴 때는 실제 native UI 요청을 유지하며 “터미널이 입력 대기 중”이라는 보고만 남기고 종료하지 않는다. 사용자 취소/무응답은 적용 승인이 아니다.
6. `status: configured`와 exit 0을 받은 뒤 초기 기준 commit 준비로 이어간다. `needs_input`과 exit 0은 다음 질문을 뜻한다. CLI 오류는 원문과 종료 코드를 보고하고 사용자에게서 받은 중단 조건을 따른다. 일반적인 terminal CLI는 수동 사용을 위해 유지하되 `$setup`은 이 native UI 경로만 사용한다.

CLI는 선택지 발견·검증·설정 적용을 소유하고 스킬은 native UI 전달만 맡는다. 프로젝트 기존 파일은 보존한다. `observability.victorialogs.local.enabled: true`이면 설치된 `victorialogs-local-setup`을 이어 실행해 OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics·공식 MCP 두 개와 실제 앱 개발 profile을 연결한다. 앱 기준 metrics_url과 컨테이너 기준 scrape_url을 구분하고 포트를 추정하지 않는다. GUI·숨은 PTY나 별도 설치 절차를 요구하지 않는다.
