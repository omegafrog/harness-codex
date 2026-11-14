# 설정 선택

워크트리 생성 위치는 절대 경로로 받는다. 기본값은 프로젝트 옆 `<프로젝트명>-worktrees`이며 선택한 상위 디렉터리 아래에 각 worktree를 만든다. 기존 설정 재사용 시 위치가 없으면 이 항목을 묻고, 위치를 바꾸려면 새로 설정을 선택한다. 기존 worktree는 이동하지 않는다.

1. 같은 cwd에서 `node .codex/scripts/harness-setup.mjs --root <absolute-project-root> --start`를 실행하고 프로세스 종료를 기다린다. CLI가 새 setup 세션을 만들고 반환한 `answers_path`에 답변을 저장한다. 이전 실행의 파일이나 공유 경로 포인터를 만들거나 사용하지 않는다.
2. 같은 setup의 질문을 이어갈 때는 반환된 `answers_path`로 `node .codex/scripts/harness-setup.mjs --root <absolute-project-root> --answers <answers_path>`를 실행한다. 기존 설정이 있으면 CLI가 현재 설정을 재사용할지 새로 설정할지 먼저 묻는다. 재사용을 선택하면 유효한 값은 유지하고 누락·오류 항목만 확인한다. `status: configured`만 적용 완료다.
3. `status: needs_input`이면 CLI가 세션에 저장한 `setup_id`, `batch_id`, `questions`, `ui_questions`를 확인한다. `questions`는 현재 조건이 확정된 질문의 `id/prompt/type/options/current/context`다. `pending`은 호환용 첫 질문이므로 쓰지 않는다. **`request_user_input_async({"questions": <반환된 ui_questions 그대로>})`를 한 번 호출한다.** 제목·순서·선택지를 고치거나 질문을 추가하지 않는다. `ui_questions`는 prompt·현재 text 값·context와 선택지 label을 이미 포함한다. 현재 값이 있는 자유 입력은 `현재 값 사용: ...` 선택지를 제공하며, 다른 값은 직접 입력한다. 도구가 없으면 사유를 답하고 중단하며 PTY나 별도 창으로 우회하지 않는다.
4. 선행 선택에 따라 존재하거나 달라지는 질문은 해당 선택이 답변된 뒤의 `needs_input` 배치에만 나타난다. 예를 들어 GitHub를 선택하면 로컬 계획 디렉터리는 나오지 않고, 로컬 관측성을 끄면 해당 포트·보존 기간·프로젝트·서비스·Actuator 질문은 나오지 않는다. 마지막 확인 질문(`이 설정으로 계속할까요?`)은 현재 설정 답변을 적용한다는 뜻이며, 모든 질문을 마친 배치에서만 최종 요약을 보여 준다.
5. 도구의 `accepted: true`는 접수일 뿐 답변이 아니다. [실제 전달 경로](answer-delivery.md)에 따라 폼 답변이나 단일 선택 질문에 대한 채팅 답변이 도착하면 `node .codex/scripts/harness-setup.mjs --root <root> --answers <answers.json> --receive-rollout`을 실행한다. CLI가 현재 대화 기록을 찾는다. CLI가 접수된 호출을 연결하고 현재 폼의 모든 응답을 수집한다. 응답을 별도 파일로 복사하거나 직접 조립하지 않는다. 호출이 없거나 여러 개면 추측하지 말고 원인을 답한다. 대화 기록 검색·해석을 위한 `node -e`나 임의 스크립트·추가 상태 조회는 실행하지 않는다.
6. CLI는 `questionItemId`의 호출 ID·항목 번호로 답을 연결하고 label을 value로 변환한다. 다른 폼의 답은 무시하고 중복 답은 안전하게 처리한다. 선택 질문이 하나일 때 사용자가 채팅으로 선택지 전체를 정확히 입력한 경우에도 해당 답으로 기록한다. 그 외 채팅은 추측하지 않는다. 설정 중단·설명 요청에 먼저 답한다.
7. 수신 결과의 `missing_question_ids`와 `can_continue`를 확인한다. `waiting`이면 대화 기록에 이미 도착한 답을 모두 수집한 뒤에만 남은 응답을 기다린다. 새 답이 도착하면 같은 `--receive-rollout`을 다시 호출한다. `ready`와 `can_continue: true`이면 **추가 입력을 요구하지 말고 즉시 2를 실행**한다. 새로운 `needs_input` 배치만 3부터 처리한다.
8. 사용자가 중단·일시 정지·진행 금지를 요청하면 **먼저** `--answers <answers.json> --cancel`로 종료 상태를 기록하고 사용자의 요청·원인 설명에 답한다. 원인 설명을 요청하면 설정 진행보다 답변을 우선하고, 진행하지 말라는 뜻이면 같은 종료 절차를 따른다. `cancelled` 이후 늦은 폼 응답은 CLI가 무시하며 설정을 재개하지 않는다. 재개를 명시적으로 요청받으면 새 setup UUID로 1부터 시작한다. 오류·자유 입력으로 전달된 이의 제기도 먼저 설명하며 기본 선택으로 대체하지 않는다.
9. CLI는 실제 Codex app-server의 live model/effort와 프로젝트 상태에서 질문을 만든다. `status: configured`와 exit 0을 받은 뒤 초기 기준 commit 준비로 이어간다. `needs_input`, `waiting`, `ready`는 적용 완료가 아니다. 답변·배치 기록은 session에만 쓰며 최종 확인 전에는 프로젝트 설정·준비 파일을 바꾸지 않는다. CLI 오류는 원문과 종료 코드를 보고한다. 일반 terminal CLI는 수동 사용을 위해 유지하되 `$setup`은 이 native UI 경로만 사용한다.

CLI는 선택지 발견·검증·설정 적용을 소유하고 스킬은 native UI 전달만 맡는다. context budget은 기존의 유효한 값을 유지하고 누락·오류 시 안전한 기본값을 사용한다. 프로젝트 기존 파일은 보존한다. `observability.victorialogs.local.enabled: true`이면 설치된 `victorialogs-local-setup`을 이어 실행해 OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics·공식 MCP 두 개와 실제 앱 개발 profile을 연결한다. 앱 기준 metrics_url과 컨테이너 기준 scrape_url을 구분하고 포트를 추정하지 않는다. GUI·숨은 PTY나 별도 설치 절차를 요구하지 않는다.

같은 setup의 수신·연결·중단·다음 배치 실행은 한 번에 하나씩 직렬로 호출한다. 여러 응답을 받았으면 원본 대화 기록에서 모두 수집한다.

Project owner 답변을 잘못 기록했거나 유효하지 않아 조회에 실패하면 사용자의 정정 요청을 먼저 확인하고 `node .codex/scripts/harness-setup.mjs --root <root> --answers <answers.json> --revise "Project owner#1"`를 실행한다. CLI는 해당 답변과 그에 의존하는 Project 선택·최종 확인을 지우고 현재 배치를 폐기한다. 같은 setup의 2부터 다시 진행해 새 폼에서 사용자가 값을 고르게 한다. 의미가 모호한 자유 입력은 추측하지 않고 뜻을 확인한다. 취소·완료된 setup은 수정하지 못한다.

## Claude Code에서의 전달

Claude Code에는 `request_user_input_async`와 Codex rollout이 없으므로 3~7단계를 다음으로 대체한다. 1·2·8단계(`--start`, `--answers`, `--cancel`)와 `--revise`는 같다.

1. `needs_input`의 `questions`를 순서대로 `AskUserQuestion`으로 묻는다. 한 번에 4개까지 가능하므로 4개씩 나눠 호출하고, 제목·선택지 label은 `ui_questions`와 같게 둔다. 텍스트 질문은 `현재 값 사용: ...` 선택지와 Other 입력을 쓴다. 질문을 추가·생략·재배열하거나 기본값으로 대신 답하지 않는다.
2. 사용자의 답을 `<session>/runtime/setup/<setup-id>/reply-N.json`에 `[{"question_id": "<questions[i].id>", "answer": "<선택한 label 또는 입력값>"}]`로 쓴다. 이 파일은 사용자가 실제로 고른 값만 담으며 추정값을 넣지 않는다.
3. `node .codex/scripts/harness-setup.mjs --root <root> --answers <answers.json> --reply <reply-N.json>`을 실행한다. CLI가 각 답을 현재 배치의 질문·선택지와 대조하고, 배치의 모든 질문이 답을 받으면 `can_continue: true`를 반환한다. 선택지에 없는 label은 오류로 거부한다. `--reply`는 Claude Code 전용이고 Codex는 `--receive-rollout`만 쓴다.
4. `can_continue: true`이면 2단계의 `--answers`를 다시 실행해 다음 배치나 `configured`를 받는다.
