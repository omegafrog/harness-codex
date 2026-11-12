# 실행 조율

모든 stage의 공통 상태·코드 조합과 반환 방법은 [Stage 반환 계약](references/stage-return.md)을 따른다. 실행기가 이 본문을 각 stage에 전달한다.

질문 형식도 그 계약이 정한다. 사용자에게 질문을 제시할 때 질문 도구에는 `title`과 문자열 options만 전달하고 결과 객체를 그대로 전달하지 않는다.

실행할 스킬과 다음 단계는 orchestrator가 요청과 결과를 기준으로 결정한다. 작업 위치는 정본 `worktree.json`에서 읽는다. 각 skill의 model·effort는 setup이 `agents.<provider>`에 쓴 네 tier(`high_performance`·`implementation`·`execution`·`low_performance`)의 값이며, 어느 tier를 쓰는지는 skill 문서 frontmatter의 `model_tier`가 정하고 workflow stage의 선택적 `model_tier`가 덮어쓴다. 하위 agent의 model·effort는 `node .codex/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill <skill>`이 반환한 값만 쓴다. skill은 사용자 결정과 workflow 단계 전환을 직접 처리하지 않고 caller에 반환한다.

For assigned headless stages, the runner supplies the selected internal GUIDE and current input. Load linked procedures only when their phase begins; do not preload later-phase references. On same-session resume, continue from new answers or feedback and the current phase without rereading unchanged entry instructions. If a new session or context compaction leaves required rules unavailable, reload the current phase's guide and authoritative references before proceeding.

비대화식 Claude 메인 orchestrator의 시작과 재개는 대상 workspace를 cwd로 `node .claude/harness/scripts/harness-claude-orchestrator.mjs '<요청>'` 또는 `node .claude/harness/scripts/harness-claude-orchestrator.mjs --resume '<session-id>' '<요청>'`으로 실행한다. 이 호출은 사용자 요청 범위의 메인 Claude에 `bypassPermissions`를 명시한다. 각 stage의 권한은 아래 profile 규칙을 따른다.

orchestrator가 직접 시작하는 단계는 `harness-agent-run.mjs`로 실행한다. 입력 검증·상태 기록·gate는 공통 runner가 소유하고 명령 실행·결과 해석·세션 재개는 `.harness/src/workflow/providers/`의 선택된 adapter가 소유한다. `agents.provider`의 기본값은 `codex`다. 같은 단계 재개는 `worktree.json`에 기록된 provider를 유지하며 단계 경계에서는 설정된 provider를 사용한다. Codex는 native subagent를, Claude Code는 `.claude/agents/<role>.md`에 설치된 동일 role의 native subagent를 사용한다. Claude subagent의 시작·종료 ID와 결과는 `runtime/executions/<execution-id>/subagents.jsonl`에 기록한다. 저장되지 않은 subagent 식별자나 결과는 추정하지 않는다. 사용자 질문은 부모가 공통 질문 계약으로 반환한다.

실행기는 정본 worktree와 Git 등록을 확인하고 입력·답변·피드백 및 실행 디렉터리의 실제 절대 경로를 결정해 전달한다. 실행기와 결과 검증기·listener는 같은 경로 계산을 사용하며 모델이 결과 파일 위치를 선택하지 않는다. 리뷰 대상은 정본 workspace와 admission snapshot을 기준으로 지정한다. 결과 artifact는 기존 `base`와 상대 경로를 사용한다. Claude의 파일 권한 거부 경로와 workspace 포함 여부는 해당 실행의 process-events에 기록한다.

`to-ticket` 완료 후 orchestrator는 리뷰를 통과한 전체 계획과 발행 대상을 사용자에게 보여주고 발행 승인을 받는다. 실제 승인 또는 사용자가 명시적으로 위임한 승인만 받은 뒤 `harness-prepare-input.mjs --worktree-ref <worktree_ref> --stage-id tracker-publish --publication-approved true`로 publisher 입력을 준비한다. 승인 거부·미응답은 publisher를 호출하지 않는다. 사용자가 계획 수정을 요청하면 `to-ticket`으로 돌아가 다시 리뷰하고 승인받는다.

Workflow stage execution maps the manifest's stage `role` to `.codex/agents/<role>.toml` or the installed Claude equivalent `.claude/agents/<role>.md` and applies that profile's sandbox/permission mode. `danger-full-access` is permitted only for an explicitly designated workflow stage; in this repository it is reserved for `tracker-publish` in the `to-ticket` workflow and is not inherited by the plan author or other stages.

부모 stage 프로세스가 중단되면 [실행과 결과](references/dispatch.md)의 중단 복구 절차로 같은 provider의 부모 대화를 재개한다. 재개된 대화의 native subagent 기록과 현재 작업 context를 이어 쓰며, Harness `agent_sessions`와 provider runtime 기록에 없는 subagent ID를 만들거나 완료되지 않은 위임을 완료로 추정하지 않는다.

- 입력 준비와 최초 worktree 생성: [입력 준비](references/input.md)
- 출력 계약과 실행 상태: [스키마와 실행 상태](references/state.md)
- 선택한 실행 호출과 결과 검증: [실행과 결과](references/dispatch.md)

전체 단계와 정본·자율 라우팅 경계는 [workflow 지도](references/workflow-map.md)를 따른다.
