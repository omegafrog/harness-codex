# 실행 조율

모든 skill 실행 결과는 질문이 하나여도 `questions` 배열만 사용한다. 질문이 없으면 빈 배열을 반환하며 결과 최상위에 `question` 필드를 사용하지 않는다. 배열 항목의 `title`은 질문 문장이다. 질문 도구에는 `title`과 문자열 options만 전달하고 결과 객체를 그대로 전달하지 않는다.

실행할 스킬과 다음 단계는 orchestrator가 요청과 결과를 기준으로 결정한다. 작업 위치는 정본 `worktree.json`에서 읽는다.

orchestrator가 직접 시작하는 단계는 `harness-codex-run.mjs`로 실행한다. 그 단계 내부의 위임 작업은 Codex native subagent 도구를 사용하고, 각 요청에 skill 지침, agent profile, 목적, 필요한 입력 context와 결과 계약을 전달한다. 부모 세션 재개는 같은 Codex 대화를 이어가므로 그 대화에 남은 위임 context와 session 산출물을 확인해 계속한다. 저장되지 않은 subagent 식별자나 결과는 추정하지 않는다. 사용자 질문은 부모가 공통 질문 계약으로 반환한다.

`to-ticket` 완료 후 orchestrator는 리뷰를 통과한 전체 계획과 발행 대상을 사용자에게 보여주고 발행 승인을 받는다. 실제 승인 또는 사용자가 명시적으로 위임한 승인만 받은 뒤 `harness-prepare-input.mjs --worktree-ref <worktree_ref> --stage-id tracker-publish --publication-approved true`로 publisher 입력을 준비한다. 승인 거부·미응답은 publisher를 호출하지 않는다. 사용자가 계획 수정을 요청하면 `to-ticket`으로 돌아가 다시 리뷰하고 승인받는다.

Workflow stage execution maps the manifest's stage `role` to `.codex/agents/<role>.toml` and applies that profile's sandbox. `danger-full-access` is permitted only for an explicitly designated workflow stage; in this repository it is reserved for `tracker-publish` in the `to-ticket` workflow and is not inherited by the plan author or other stages.

부모 stage 프로세스가 중단되면 [실행과 결과](references/dispatch.md)의 중단 복구 절차로 같은 부모 Codex 대화를 재개한다. 재개된 대화의 native subagent 기록과 현재 작업 context를 이어 쓰며, Harness `agent_sessions`에 없는 subagent ID를 만들거나 완료되지 않은 위임을 완료로 추정하지 않는다.
stage 내부 위임은 반환 code나 dispatcher 요청을 만들지 않는다. stage가 native subagent 결과를 확인하고 자기 산출물·리뷰·질문을 마무리해 공통 결과를 반환하며, 다음 workflow stage는 orchestrator만 선택한다.

- 입력 준비와 최초 worktree 생성: [입력 준비](references/input.md)
- 출력 계약과 실행 상태: [스키마와 실행 상태](references/state.md)
- 선택한 실행 호출과 결과 검증: [실행과 결과](references/dispatch.md)
