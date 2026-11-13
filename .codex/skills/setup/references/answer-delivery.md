# setup 답변 전달 근거와 연결

2026-11-13 실제 setup 대화 기록(Codex CLI 0.167.2)을 확인했다. `request_user_input_async`의 반환은 `{"accepted":true}`이며, 실제 답은 뒤의 사용자 메시지에 아래처럼 항목별로 도착한다. 질문 제목의 줄바꿈은 공백으로 합쳐질 수 있다.

```text
<send_user_message_question_reply>
[{"answer":"GitHub Project","question":"Tracker 선택 현재 linked worktree를 유지합니다.","questionItemId":"[\"request_user_input_async\",\"call_…\",1]"}]
</send_user_message_question_reply>
```

`questionItemId`를 JSON으로 해석하면 `[도구 이름, 호출 ID, 0부터 시작하는 항목 번호]`다. rollout의 `response_item/function_call`은 `name`, `call_id`, `arguments`를 담고, `function_call_output`은 같은 `call_id`와 접수 결과를 담는다. `--bind-ui`는 이번 배치 이후 접수된 호출의 질문 개수와 항목별 선택지를 대조한다. 최종 확인에서는 승인 대상인 설정 요약 전체를 검증한다. 호출이 유일하지 않으면 추측하지 않는다.

2026-11-13 재현에서는 답변의 `question`이 UTF-8 기준 512바이트에서 잘렸다. 답변은 이 제목을 비교하지 않고, 연결된 호출 ID와 항목 번호로만 해당 질문에 연결한다. 다른 호출의 답변은 무시한다.

같은 기록에서 provider·tracker·Beads·관측성의 실제 4개 개별 응답을 새 수집 함수에 읽기 전용으로 전달해 호출 연결과 마지막 답 이후 `can_continue: true`를 확인했다. 이 확인은 실제 과거 메시지의 해석 검증이며 새 setup의 live UI 실행은 아니다.

CLI가 `CODEX_THREAD_ID`와 `CODEX_HOME`으로 현재 대화 기록을 찾아 `session_meta`의 ID와 `cwd`를 검증한다. 스킬이 경로를 검색하거나 대화 내용을 직접 해석하지 않는다. 기록이나 접수 확인이 없으면 오류를 보고한다.

Harness의 `UserPromptSubmit` hook은 `event.prompt`를, 질문 도구 `PostToolUse` 경로는 `event.tool_response` 또는 `event.tool_output`을 읽는다. 기존 질문 도구 matcher는 `AskUserQuestion`과 `request_user_input`이며 async 도구는 포함하지 않는다. 실제 대화 기록은 사용자 메시지 형태를 증명하지만, 이 메시지가 같은 구조로 hook payload에 전달된다는 실측 근거는 없다. 따라서 hook에 async 자동 수신이나 설정 재개를 추가하지 않는다. 스킬은 경로 인자 없이 `--receive-rollout`을 실행한다. CLI가 실제 사용자 응답을 모두 읽어 해당 배치의 항목을 수집한다. 별도 답변 파일은 만들지 않는다. 수신 명령은 다음 설정 실행이나 파일 적용을 시작하지 않는다.

답변은 `.io/runtime/setup/<setup-id>/answers.json`의 현재 배치에 누적한다. 표시 인자·호출 ID·항목 대응·수신 답·종료 상태를 함께 보존하므로 부분 응답 뒤 대화가 끊겨도 `--status`로 누락을 확인할 수 있다. 이전 폼의 응답과 중단 후 응답은 진행 근거가 아니다. 실제 UI에서의 수동 재검증과 설치 소비자 fixture 회귀는 별도로 구분한다.
