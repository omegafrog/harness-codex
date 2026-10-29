# 정적 호출기

호출자는 `workspace_root`, `shared_guidance_root`, `session_directory`, skill 입력과 적용할 workflow stage를 지정한다. 작업 위치와 session은 전달된 정본을 사용한다.

```sh
node .codex/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill <skill-id> [--workflow <workflow-id> --stage <stage-id>]
node .codex/scripts/harness-skill-exec.mjs --root <workspace_root> --session-directory <session_directory> --input <session-relative-input.json>
```

구성된 workflow stage는 다음 명령으로 호출한다.

```sh
node .codex/scripts/harness-skill-exec.mjs --root <workspace_root> --session-directory <control-session-directory> --request-workflow runtime/orchestrator/workflow.json --stage <stage-id> --codex-session-id <codex-session-id>
```

호출기는 설정된 model·reasoning effort를 해석하고 `codex exec --output-schema`로 실행한다. 입력과 결과 스키마 및 binding은 `../skill-execution/schemas/`와 `../skill-execution/bindings.json`에 있다. 프로세스 실패·반환 누락·검증 실패는 오류로 보고한다. `workspace_root`와 `shared_guidance_root`가 같은 Git common directory인지 확인하고 session 출력 경계를 유지한다.

호출 결과의 판단과 다음 단계는 호출한 workflow가 담당한다. 호출기는 실행 상태와 결과를 기록하며 호출자는 `state.json`을 직접 수정하지 않는다.

질문에 대한 실제 답변은 stage 호출에 `--answer <답변>`으로 전달한다. 하위 작업 선택과 결과 전달은 각각 `--subtask <index>`, `--subtask-result <execution_id>`를 사용한다. 리뷰 재개에는 `--review-subtask`와 `--review-result`를 사용한다.
