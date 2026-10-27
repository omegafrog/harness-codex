---
name: setup
description: Initialize a repository for the harness workflow. Use when setting up a repository for the first time, when CONTEXT.md or CONTEXT-MAP.md is missing, when agent model tiers have not been chosen, or when tracker configuration has not been chosen.
---

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [implementation-guidance](../../../.codex/internal-skills/implementation-guidance/GUIDE.md) · [sync-contracts](../../../.codex/internal-skills/sync-contracts/GUIDE.md) · [testing-guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md).

# Harness Setup

## 실행 모델과 반환

기본 `model_tier`는 `execution`이며 `agents.execution_model`와 `agents.execution_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [공통 skill 실행 계약](../../../.codex/internal-skills/skill-execution/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

Initialize repository-owned context, agent model tiers, and tracker settings before running `spec-me` or `to-ticket`. **Codex CLI 내부의 네이티브 선택 UI**로 설정한다. 외부 터미널·설치기 메뉴·agent-only PTY·일반 채팅의 번호 질문으로 대체하지 않는다.

## Codex 내부 선택 흐름

1. `harness-session-output.mjs --root <absolute-project-root>`로 session directory를 구하고 그 안의 `runtime/setup/answers.json`을 만든다. 최초 내용은 `{"answers":{}}`이며 이전 사용자 답이 있으면 보존한다.
2. 같은 cwd에서 다음 비대화 명령을 실행한다. 이 명령은 사용자 입력을 stdin에서 기다리지 않고 다음 질문 또는 적용 결과를 JSON으로 반환한다.

   `node .codex/scripts/harness-setup.mjs --root <absolute-project-root> --answers <session_directory>/runtime/setup/answers.json`

3. `status: needs_input`이면 `question.prompt/options/current/context`를 읽어 **사용 가능한 `request_user_input_async` 또는 `request_user_input` 선택 도구**로 표시한다. 도구의 실제 availability와 mode 제한을 지키며 지원되지 않는 도구를 호출하거나 mode를 임의 전환하지 않는다. 도구가 없으면 네이티브 UI 미지원 사유를 보고하고 중단하며 PTY/별도 창으로 우회하지 않는다. `type: text`도 같은 네이티브 입력 도구를 사용한다. 선택지가 도구의 표시 한도를 넘으면 페이지를 나누되 실제 선택 항목을 누락하지 않는다.
4. 사용자가 제출한 응답만 `answers[question.id]`에 해당 option.value 또는 입력 문자열로 기록하고 응답의 `configuration_hash`도 보존한다. 최종 적용 질문은 context의 실제 선택 요약을 함께 표시한다. 기본값·권장값·선택 도구의 사전 선택을 제출로 간주하지 않는다. AI가 모델·effort·tracker·관측성 값을 임의 선택하지 않는다. 도구 label을 backend value로 정확히 매핑한다.
5. 2~4를 반복한다. CLI는 실제 Codex app-server의 live model/effort와 프로젝트 상태에서 질문을 만들며 유효하지 않은 선택·변경된 configuration snapshot을 거부한다. 답을 기다릴 때는 실제 native UI 요청을 유지하며 “터미널이 입력 대기 중”이라는 보고만 남기고 종료하지 않는다. 사용자 취소/무응답은 적용 승인이 아니다.
6. `status: configured`와 exit 0을 받은 뒤 실제 source 기반 실행 계약·통합 계약 준비로 이어간다. `needs_input`의 exit 0은 완료가 아니다. CLI 오류는 원문을 보고하고 설정 미완료로 남긴다. 일반적인 terminal CLI는 수동 사용을 위해 유지하되 `$setup`은 이 native UI 경로만 사용한다.

CLI는 선택지 발견·검증·설정 적용을 소유하고 스킬은 native UI 전달만 맡는다. 프로젝트 기존 파일은 보존한다. `observability.victorialogs.local.enabled: true`이면 설치된 `victorialogs-local-setup`을 이어 실행해 OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics·공식 MCP 두 개와 실제 앱 개발 profile을 연결한다. 앱 기준 metrics_url과 컨테이너 기준 scrape_url을 구분하고 포트를 추정하지 않는다. GUI·숨은 PTY나 별도 설치 절차를 요구하지 않는다.

## Context Files

1. Treat the current working directory as the repository root.
2. If `CONTEXT.md` is missing, create it from `assets/CONTEXT.md`.
3. If `CONTEXT-MAP.md` is missing, create it from `assets/CONTEXT-MAP.md`.
4. Never overwrite either file. If a requested replacement cannot be handled by the CLI without data loss, preserve the file, record the conflict, and leave setup incomplete for manual resolution; do not ask in chat.
5. Tell the user which files were created and which existing files were preserved.

Create `docs/agents/implementation-guidance.md` and `docs/agents/testing-guidance.md` from the installed skills' reference templates when absent. These are project-owned Markdown documents. Never overwrite existing guidance. For managed worktree workflows, `return_root` is their shared canonical location; pass it as `shared_guidance_root` to every implementation and test worker. The workflow owner updates implementation guidance from explicit user direction or settled Specs, and testing guidance from explicit reusable user preferences or confirmed reusable test lessons; ordinary implementation and test workers read them without editing.

When later architecture work establishes reusable models, link `docs/architecture/domain-model.md` from `CONTEXT-MAP.md` under the DDD model continuity contract; do not seed imaginary aggregates during setup. Verification maps belong to the consumer project and can be seeded/maintained with `maintain-verification`; launch/server configuration remains in `docs/agents/EXEC.md`.

## 실행 계약 준비

실제 테스트/서버/인프라 entrypoint·필수 인자·config loader·compose/CI를 조사해 `docs/agents/EXEC.md`의 실행 계약과 `docs/agents/execution.json`을 작성한다. 각 프로필은 정확한 command, required_env, config_inputs, prepare, verify_config, dependencies 및 timeout/poll 값을 포함한다. 필요한 설정 갱신과 실제 readiness를 검증하는 프로젝트 명령을 사용한다. 인프라/prepare 불필요의 근거를 EXEC에 기록한다. 기존 사용자 프로필은 보존하고 Harness 원본의 명령을 소비 프로젝트에 복사하지 않는다. 불명확한 값은 추정하거나 사용자에게 채팅으로 묻지 않는다. 정확한 누락값과 이를 찾지 못한 source 범위를 기록하고 관련 실행을 차단한다.

## 설치·업데이트 및 구현 전 준비 복구

설치·업데이트가 `project_preparation_required`를 보고하거나 구현 진입의 `--for-implementation` 검사가 실패하면 이 준비 절차를 호출자가 수행한다. 파일 누락 자체를 외부 blocker로 넘기거나 커밋 후까지 미루지 않는다. 기존 model/tracker 선택을 다시 묻지 않고 누락·불일치 범위만 보완한다.

1. 명시한 `workspace_root`에서 source·테스트·기존 EXEC·package/build scripts·CI·compose·config loader를 읽는다. 예정 검증에 필요한 집중 테스트와 해당 시 E2E 프로필을 위 실행 계약 형식으로 작성한다. 환경값·인프라를 추정하거나 테스트를 직접 실행하지 않는다.
2. `sync-contracts`로 기존 전체 기능·용어·DDD 모델을 조사하고 실제 통합 계약·연결 다이어그램·manifest를 생성/동기화한다. 빈 manifest, Harness 원본 계약 복사, seal만으로 의미 검토 대체는 금지한다. 기존 소비 프로젝트 문서·프로필은 보존하며 필요한 부분을 갱신한다.
3. `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --for-implementation --json`을 같은 cwd에서 재실행한다. `valid: true` 전에는 구현·구현 커밋·In Progress 전환·agent dispatch를 시작하지 않는다. 설치·업데이트는 doctor도 재실행한다. 해결할 수 없는 업무 결정이나 비밀값은 대화로 묻지 말고 정확한 차단 사유로 보고한다.
4. 준비 변경을 실행 기준 branch에 보존한 뒤 fixed point/병렬 fixed base를 확정한다. 이미 구현된 작업의 복구는 기존 구현·commit·stash·tracker 상태를 보존하고 준비 후 원래 검증/완료 절차로 재개한다. 불필요한 stash·상태 되돌리기나 제품 코드 수정은 하지 않는다.

자동 검사는 프로필 형식과 계약 snapshot 정합성을 확인한다. 선택한 프로필이 실제 예정 검증/인프라를 포괄하는지는 호출자가 source와 계획으로 확인하고, 실행 시 launcher가 환경·설정·readiness를 다시 검증한다.

## Harness Ignore List

Keep the Harness runtime local to each checkout. During installation, the installer adds `.codex/` to that repository's `.git/info/exclude`, so Harness settings, agents, workflows, scripts, and lock files are not committed. Shared project decisions and instructions belong in tracked `AGENTS.md`, ADRs, and domain documents outside `.codex/`.

1. Preserve all existing project-specific rules.
2. Update the repository `.gitignore` with this Harness-generated runtime-only artifact rule only when it is missing:

```gitignore
# Harness runtime-only artifacts
.codex/sessions/
```

3. Keep ticket-scoped Product Specs, Architecture Specs, and plan documents tracked:
   - `docs/specs/<ticket-id>/**`
   - `docs/plans/<plan-set-id>/<plan-id>.md`
   - `docs/plans/<plan-set-id>/plans.md` when `local-markdown` is selected
4. Do not add `.codex/` to the shared `.gitignore`; its local exclusion is managed by the installer in `.git/info/exclude`.
5. Do not add generic project rules such as `venv/`, `.venv/`, `.serena/`, or `.playwright-cli/`.
6. Do not add obsolete runtime paths such as `.harness/**`, `docs/changes/`, or `docs/use-cases/`.
7. Make the `.gitignore` update idempotently and report whether the rule was added or already present.

## 설치·갱신 후 작업공간 정리

1. 정리 전에 `git status --short`로 변경·미추적 경로를 수집하고, installer ownership inventory와 대조해 Harness 관리 산출물과 프로젝트 소유 파일을 구분한다.
2. consumer의 Harness 관리 경로는 installer가 관리하는 `.git/info/exclude` 또는 소유권에 맞는 `.gitignore`와 동기화하고, 대표 경로마다 `git check-ignore -v <path>` 결과를 확인한다. 프로젝트 소유 준비 문서인 `docs/agents/EXEC.md`, `docs/agents/execution.json`, `docs/contracts/**`는 Git 추적 대상으로 유지한다.
3. 변경·미추적 파일 전체를 session backup에 보존하고 백업 파일 목록을 확인한다. ignore 규칙은 tracked modification에 적용되지 않으므로 tracked 파일도 백업한다.
4. 소유권을 확인한 Harness 관리 산출물만 경로별로 정리하고, 정리 후 `git status --short`와 백업을 다시 확인한다.

## Agent Model Setup

Model and reasoning-effort options come from the live Codex app-server schema through `harness-setup.mjs --answers`. Collect the user selection through Codex native choice UI; never hardcode a model list or substitute plain-chat questions. The CLI preserves unrelated `.codex/harness.yaml` keys and confirms before writing.

## Context budget

모델 선택 뒤 CLI가 공통 context 한도, plan 하나의 최대 예상 토큰, checkpoint·인계용 예비 토큰을 사용자에게 확인하고 `.codex/context-budget.json`에 저장한다. 숫자를 추측하거나 자동 기본값으로 채우지 않는다. 공통 한도는 선택한 모델들에서 실제 사용 가능한 범위로 확인한다.

`max_plan_tokens + handoff_reserve_tokens <= context_window_tokens`여야 한다. `to-ticket`은 원본 프로젝트의 이 파일을 읽어 각 plan의 예상 토큰과 policy hash를 기록하고 한도 안으로 분할한다. orchestrator는 같은 기준으로 실제 사용량과 다음 작업 예상량을 비교해 인계를 결정한다. 구현 worker에는 Smart Zone 판정을 맡기지 않는다. 파일이 없으면 해당 caller가 설정 누락으로 반환하며 setup을 자동 호출하지 않는다.

## Beads Project Board

Beads 사용 여부, CLI 설치, 기존 workspace 보존, 원격 bootstrap 또는 새 초기화 확인은 모두 `harness-setup.mjs --answers`가 반환하는 질문을 Codex native UI에서 제출받아 처리한다. 일반 채팅 질문이나 별도 터미널로 승인·초기화를 대체하지 않는다. CLI가 성공한 경우에만 project root에서 `bd status`를 확인한다. 사용자가 Beads를 선택하지 않았으면 Beads 명령을 실행하지 않으며, 해당 프로젝트의 `to-ticket`이 Beads 의존으로 막힌다는 사실을 setup 결과에 기록한다.

Linked Git worktrees in the same repository share the Beads workspace through Git common-directory discovery. Do not initialize a separate board in a linked worktree or copy `.beads` into it. For a remote-backed schema migration, designate one clone to migrate and publish; every other clone adopts that result with the Beads-supported bootstrap procedure. Never migrate multiple clones independently.

## Tracker Setup

Tracker options and GitHub Project field validation are provided by `harness-setup.mjs --answers`; collect selection through Codex native UI. Do not ask tracker questions as plain chat or create tickets during setup. If GitHub access or API limits prevent validation, report the exact CLI error and leave setup incomplete.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

초기 setup에서 통합 계약이 없다면 기존 source·테스트·Spec을 조사하여 `sync-contracts` 형식으로 최초 bundle과 다이어그램을 생성한다. 빈 manifest나 예시 모델을 설치 프로젝트의 실제 모델로 취급하지 않는다. Product/Architecture 문서는 생성할 수 있으며 product code를 새로 만드는 것은 setup 범위가 아니다. 기존 업무 지식만으로 확인할 수 없는 규칙은 질문하지 않고 미확정·미완료로 기록해 관련 설계/구현을 차단한다.

## Tracker 보드 표시와 새 mirror 정책

GitHub Project의 보드 그룹과 필터는 configured `Workflow Status`를 사용하고 기본 `Status`는 workflow 기준으로 사용하지 않는다. setup 결과에 보드의 group-by를 `Workflow Status`로 선택하고 기본 `Status` 열을 숨기는 UI 설정을 안내한다. CLI가 지원하지 않는 view 변경을 성공했다고 보고하지 않는다. Project field 삭제나 기존 item 상태 migration은 하지 않는다.

신규 Beads mirror는 네 가지 lifecycle 기본 상태만 사용한다. 초기 프로젝트 설정은 `bd config set status.custom ""`로 custom status를 비워 기본 상태만 사용한다. 사용자가 따로 운영하는 custom 설정을 무조건 덮어쓰거나 기존 Issue를 migration하지 않는다. backlog 분류와 test/review 단계는 `beads` 스킬의 metadata로 분리한다. `to-ticket`이 새로 연결한 ref에만 lifecycle version marker를 기록하고 공통 sync/check를 사용한다.

## Native UI 도구 근거

[Codex 공식 사용자 입력 도구 정의](https://github.com/openai/codex/blob/main/codex-rs/prompts/src/model_messages.rs)를 참고하되 실제 세션에 노출된 도구만 사용한다. 비동기 선택 UI의 사전 선택도 사용자가 제출하기 전에는 답이 아니다.
