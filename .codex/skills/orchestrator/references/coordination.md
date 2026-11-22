# 실행 조율

stage 작업자의 반환 계약(status·code 조합, 질문 반환, 출력 파일 작성, 실행 산출물 위치, 작업 경계)은 설치기가 각 stage agent profile(`.codex/agents/<role>.toml`과 Claude agent 사본)의 지시문에 넣어 두므로 서브에이전트가 시작될 때 함께 적용된다. orchestrator는 그 내용을 다시 전달하거나 다른 공통 문서를 읽으라고 지시하지 않는다. `finish`가 반환하는 status·code와 `next`로 다음 단계를 정한다.

사용자에게 질문을 제시할 때 질문 도구에는 `title`과 문자열 options만 전달하고 결과 객체를 그대로 전달하지 않는다.

실행할 스킬과 다음 단계는 orchestrator가 요청과 결과를 기준으로 결정한다. 작업 위치는 정본 `worktree.json`에서 읽는다. stage의 모델·effort는 [실행 배정](dispatch.md#실행-배정)에서 지정한 사용자 값, worktree binding, setup tier 순으로 정한다. setup의 네 tier 중 어느 값을 쓸지는 skill 문서 frontmatter의 `model_tier`가 정하고 workflow stage의 선택적 `model_tier`가 덮어쓴다. stage 밖에서 배정하는 보조 작업자는 `node .harness/scripts/harness-stage-runtime.mjs binding --root <workspace_root> --skill <skill>`로 기본값을 확인하고, 사용자 지정 범위에 포함되면 지정값을 우선한다. skill은 사용자 결정과 workflow 단계 전환을 caller에 반환한다.

For an assigned stage, the caller starts a native subagent and hands it the selected internal GUIDE path and current input path. Load linked procedures only when their phase begins; do not preload later-phase references. On same-session resume, continue from new answers or feedback and the current phase without rereading unchanged entry instructions. If a new session or context compaction leaves required rules unavailable, reload the current phase's guide and authoritative references before proceeding.

비대화식 Claude 메인 orchestrator의 시작과 재개는 대상 workspace를 cwd로 `node .claude/harness/scripts/harness-claude-orchestrator.mjs '<요청>'` 또는 `node .claude/harness/scripts/harness-claude-orchestrator.mjs --resume '<session-id>' '<요청>'`으로 실행한다. 이 호출은 사용자 요청 범위의 메인 Claude에 `bypassPermissions`를 명시한다. 각 stage의 권한은 아래 profile 규칙을 따른다.

orchestrator가 직접 시작하는 모든 stage는 native 서브에이전트로 실행한다. `harness-native-stage.mjs launch`가 입력을 준비하고 실행을 예약해 입력과 schema 경로를 반환한다(`start`는 준비된 입력을 예약한다). 서브에이전트는 GUIDE·입력·schema를 직접 읽어 출력 파일을 작성하고, 호출자는 `finish`로 형식을 검증한다. 형식 오류는 잘못된 키와 값을 같은 에이전트에 돌려 재작성한다. 상세 절차는 [실행과 결과](dispatch.md)를 따른다. 실제 승인, 독립 리뷰와 workspace 신뢰 경계는 유지한다.
준비기는 정본 worktree와 Git 등록을 확인하고 입력·답변·피드백 및 실행 디렉터리의 실제 절대 경로를 결정해 전달한다. 준비기와 결과 검증기는 같은 경로 계산을 사용하며 모델이 결과 파일 위치를 선택하지 않는다. 리뷰 대상은 정본 workspace와 admission snapshot을 기준으로 지정한다. 결과 artifact는 기존 `base`와 상대 경로를 사용한다.

Workflow stage execution maps the manifest's stage `role` to `.codex/agents/<role>.toml` or the installed Claude equivalent `.claude/agents/<role>.md` and applies that profile's sandbox/permission mode. `danger-full-access` is permitted only for an explicitly designated workflow stage; in this repository it is reserved for the `tracker-publish` stage of the `to-ticket` and `tactical-to-code` workflows and is not inherited by the plan author or other stages.

서브에이전트가 중단되거나 세션 상태가 불명확하면 실제 도구 결과와 기존 세션을 확인한다. 종료되지 않은 작업을 중복 실행하거나 결과를 추정하지 않는다.
- 입력 준비와 최초 worktree 생성: [입력 준비](input.md)
- 출력 계약과 실행 상태: [스키마와 실행 상태](state.md)
- 선택한 실행 호출과 결과 검증: [실행과 결과](dispatch.md)

현재 단계에서 다음 전환을 결정할 정보가 부족할 때 [workflow 지도](workflow-map.md)의 해당 부분을 확인한다.

## 계획 발행 승인

`to-ticket` 완료 후 orchestrator는 리뷰를 통과한 전체 계획(ticket 목록·의존 순서·각 ticket의 규칙과 검증)과 발행 대상을 한국어로 사용자에게 보여 준다. 발행 여부를 물으면서 [승인 답변 형식](input.md#사용자-승인-답변-전달)을 안내한다. 사용자가 직접 답한 뒤에만 `harness-native-stage.mjs launch --stage-id tracker-publish --publication-approved true --approval-answer '<사용자 답 원문>'`으로 publisher 입력을 준비한다. 준비기는 `to-ticket` 완료 뒤의 provider 대화 기록에서 실제 사용자 메시지나 질문 도구 답변과 대조한다. 사용자가 계획 수정을 요청하면 `to-ticket`으로 돌아가 다시 리뷰하고 다시 승인받는다.

GitHub tracker를 쓰고 사용자가 계획 PR을 요청하면 발행 뒤 `plan-pr` stage를 `pr_author`로 실행한다. 이미 발행·활성화된 plan set이 변경되면 종전 발행 승인과 Issue 연결을 유지한다. 해당 Issue에 변경 내용 업데이트를 사용자 요청 범위에 따라 `harness-tracker.mjs comment --ticket <issue> --body <변경 요약>`으로 기록한다.
