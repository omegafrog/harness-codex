# setup 답변 전달 근거와 연결

2026-11-13 실제 setup 대화 기록(Codex CLI 0.167.2)을 확인했다. `request_user_input_async`의 반환은 `{"accepted":true}`이며, 실제 답은 뒤의 사용자 메시지에 아래처럼 항목별로 도착한다. 질문 제목의 줄바꿈은 공백으로 합쳐질 수 있다.

```text
<send_user_message_question_reply>
[{"answer":"GitHub Project","question":"Tracker 선택 현재 linked worktree를 유지합니다.","questionItemId":"[\"request_user_input_async\",\"call_…\",1]"}]
</send_user_message_question_reply>
```

`questionItemId`를 JSON으로 해석하면 `[도구 이름, 호출 ID, 0부터 시작하는 항목 번호]`다. rollout의 `response_item/function_call`은 `name`, `call_id`, `arguments`를 담고, `function_call_output`은 같은 `call_id`와 접수 결과를 담는다. 첫 응답의 ID만 보고 현재 폼이라고 추정하지 않는다. `--bind-ui`가 이번 배치 생성 이후의 실제 질문 인자와 접수 결과를 대조해야 한다.

같은 기록에서 provider·tracker·Beads·관측성의 실제 4개 개별 응답을 새 수집 함수에 읽기 전용으로 전달해 호출 연결과 마지막 답 이후 `can_continue: true`를 확인했다. 이 확인은 실제 과거 메시지의 해석 검증이며 새 setup의 live UI 실행은 아니다.

현재 대화 ID는 `CODEX_THREAD_ID` 또는 현재 실행 환경이 제공한 실제 session ID로 확인한다. `CODEX_HOME`(없으면 기본 Codex home)의 `sessions`에서 해당 ID의 rollout을 찾고 첫 `session_meta`의 ID와 `cwd`를 현재 대화·workspace와 대조한다. 파일의 최신 수정 시각만으로 다른 대화 기록을 선택하지 않는다. 환경이 `transcript_path`를 제공했다면 같은 검증 뒤 그 경로를 쓴다. CLI는 rollout 형식과 접수 기록이 확인되지 않으면 연결하지 않는다.

Harness의 `UserPromptSubmit` hook은 `event.prompt`를, 질문 도구 `PostToolUse` 경로는 `event.tool_response` 또는 `event.tool_output`을 읽는다. 기존 질문 도구 matcher는 `AskUserQuestion`과 `request_user_input`이며 async 도구는 포함하지 않는다. 실제 대화 기록은 사용자 메시지 형태를 증명하지만, 이 메시지가 같은 구조로 hook payload에 전달된다는 실측 근거는 없다. 따라서 hook에 async 자동 수신이나 설정 재개를 추가하지 않는다. 스킬이 실제 수신 메시지 원문을 `--receive`로 전달하고 CLI가 수신 상태만 반환한다. `--receive`·`--bind-ui`·`--status`는 다음 설정 실행이나 파일 적용을 시작하지 않는다.

답변은 `.io/runtime/setup/<setup-id>/answers.json`의 현재 배치에 누적한다. 표시 인자·호출 ID·항목 대응·수신 답·종료 상태를 함께 보존하므로 부분 응답 뒤 대화가 끊겨도 `--status`로 누락을 확인할 수 있다. 이전 폼의 응답과 중단 후 응답은 진행 근거가 아니다. 실제 UI에서의 수동 재검증과 설치 소비자 fixture 회귀는 별도로 구분한다.
