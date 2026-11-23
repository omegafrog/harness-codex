# 실행 환경 안내

## 이 문서의 역할

`.harness/agents/EXEC.md`는 **이 저장소를 실행·검증하는 방법의 정본**이다. 서버와 인프라를 띄우고 멈추는 방법, 일반 검증 명령, 사용자 흐름 E2E의 실행 기준과 환경값을 둔다. 에이전트는 서버·인프라를 실행하거나 검증하기 전에 이 문서를 읽고 따른다.

| 이 문서에 두는 것 | 다른 곳에 두는 것 |
|---|---|
| 서버·인프라 실행·중지·정리 방법, 플랫폼별 명령과 환경변수 | 모든 에이전트가 따르는 공통 규칙: `AGENTS.md` |
| 일반 단위·회귀 검증 명령(`npm test` 등)과 그 범위 | workflow 실행 규칙: 각 `.harness/internal-skills/*/GUIDE.md` |
| 사용자 흐름 E2E의 실행 환경, 원문 요청, 관찰·보존 기준 | E2E에 쓰는 구체 인자·포트·readiness 값: `.harness/agents/execution.json`의 profile |
| 이 저장소가 쓰는 외부 인프라(예: 관측성 스택)의 설치·검증 근거 | 재발 방지 학습: `.harness/agents/testing-guidance.md`, 구현 선호: `.harness/agents/implementation-guidance.md` |

변경 이력, 작업 계획, 의사결정 기록은 이 문서에 쓰지 않는다. 명령이 바뀌면 이 문서를 고치고, E2E의 인자·환경·인프라가 바뀌면 `execution.json` profile도 함께 고친다. 소비자 프로젝트에서는 `$setup`이 이 파일을 프로젝트 소유 문서로 준비하며 Harness 업데이트가 덮어쓰지 않는다.

## 플랫폼별 실행 방법

플랫폼별 설정·실행 방법을 아래에 기록한다.

### macOS / Linux

추가 지침 없음.

### Windows

추가 지침 없음.


## Harness 원본 저장소의 설치 동작

- Harness 변경은 discovery/transform, fresh install, update, Doctor, exclusions, consumer behavior/status까지 확인한다. 사용자 소유 설정은 안전한 template인 경우에만 설치한다. 폐기 managed assets는 backup 후 제거하고 수정·불명확·사용자-owned 파일은 보존한다.
- Consumer 반영 전 configured upstream에 push하고 commit을 조회한다. Update/Doctor 후 source commit, consumer 결과, `git status`를 확인한다. 정리할 때는 tracked/untracked 변경을 모두 backup/verify하고 제거 대상을 명시한다. `git check-ignore -v`를 확인하되 EXEC, `execution.json`, `docs/contracts/**`는 Git-visible로 둔다.
- Portable public entrypoints는 `.codex/skills/`·`.claude/skills/`; provider-neutral GUIDE/workflow/runtime은 `.harness/`; Codex agents는 `.codex/agents/`, Claude agents는 `.claude/agents/`에 둔다. Loader/runner는 `.harness/internal-skills/*/GUIDE.md`를 읽는다. Source checkout은 원본 `.codex` 자산을 사용하고 install/update를 건너뛴다.
- Installer lock은 public SKILL, internal GUIDE/reference/assets/scripts를 관리한다. 교체 전 `session/runtime/installer-backups/<id>/`에 backup하고 사용자-owned unmanaged 파일은 보존한다. 기본 update는 agents/runtime/CI 변경을 보존하며 `--force`는 선택된 관리 자산만 바꾼다. `.harness/harness.yaml`은 항상 보존하고 lock을 수동 재생성하지 않는다.
- Worktree 지침은 `session-worktree/references/{sequential,parallel,worktree-cli}.md`가 정본이다. 실행 위치는 정적 실행기가 Git/worktree 기록에서 정하며 agent-authored plan 경로를 쓰지 않는다.
- Focused regressions: `node --test tests/workflow_completion_retention.test.mjs`; isolated consumer checks `tests/prompt_budget.test.mjs`, `tests/stage_cli_output.test.mjs`, plus `tests/{execution_audit,review_recurrence,e2e_use_case_coverage,hook_timing,requirements_approval_order,e2e_telemetry}.test.mjs`. Fixtures do not prove live provider rollout; inspect actual execution records.

## E2E 실패 학습 계약

E2E 실패를 확인하면 `e2e-test`의 실패 학습 절차에 따라 원인 근거와 반복 여부를 기록한다. 반복되거나 재사용할 예방 절차가 확인되면 활성 workspace의 `.harness/agents/testing-guidance.md`를 갱신한다. 실행값·URL·포트·readiness profile은 `.harness/agents/execution.json`, 운영자가 따라야 할 준비·진단 절차는 이 문서에 반영하고 서로 일치시킨다. 테스트 결과와 학습 상태를 분리하며 학습 pending은 테스트 통과나 workflow 완료를 막지 않는다. `e2e-learning-check` profile의 `config_inputs`에는 이 규칙, 검증 코드와 관련 테스트를 포함한다.

## Harness 검증 경로 실행

일반 검증은 `npm test`를 저장소 루트에서 실행한다. 현재 Node 버전은 `package.json` `engines`를 따른다. 이 저장소에는 상시 server/DB가 없다. 테스트 상세·범위는 package/test source를 기준으로 하며 fixture 기반 검증을 실제 모델/E2E로 보고하지 않는다.

Workflow 명령은 현재 registered worktree에서 실행한다. Primary checkout에서 다른 worktree를 `--root`/`--worktree-ref`로 지정하지 않는다. `compose`에는 실제 `--orchestrator-provider`와 `--orchestrator-session-id`를 전달하고 생성된 절대 경로를 사용자에게 제시해 멈춘다. 사용자가 해당 경로에서 같은 대화로 다시 호출한 뒤 진행한다. 승인과 답변은 해당 worktree의 provider 대화에서 확인하며 다른 provider로 바뀌면 과거 CLI session을 재개하지 않는다. Codex identity/write-protection hooks는 Doctor로 확인한다.

주요 회귀 진입점:

- Worktree/context/hook/write guard: `node --import ./tests/support/isolated-codex-home.mjs --test tests/worktree_cwd_enforcement.test.mjs tests/cli_context.test.mjs tests/codex_orchestrator_user_hook.test.mjs tests/orchestrator_write_guard.test.mjs`.
- Setup response routing/configuration: `node --import ./tests/support/isolated-codex-home.mjs --test tests/setup_configuration.test.mjs`; UI answer delivery rules: [reference](../../.codex/skills/setup/references/answer-delivery.md).
- Workflow records/provider: `node --import ./tests/support/isolated-codex-home.mjs --test tests/worktree_record_contract.test.mjs tests/setup_configuration.test.mjs tests/skill_model_tier.test.mjs tests/provider_install.test.mjs tests/stage_checkpoint.test.mjs`.
- Review/dispatch/consumer behavior: `node --import ./tests/support/isolated-codex-home.mjs --test tests/intent_and_excess_guidance.test.mjs tests/review_scope_guard.test.mjs tests/implement_wrapper_consumer.test.mjs tests/legacy_installer_update.test.mjs tests/workflow_lookup_and_review_snapshot.test.mjs tests/implement_wrapper_completion.test.mjs`.
- UI style choices (Chromium only when available): `env -u CODEX_HOME node --import ./tests/support/isolated-codex-home.mjs --test tests/frontend_style_options.test.mjs`.
- Consumer install/update checks use a disposable Git repository and `node bin/harness-install.mjs install|update --project <consumer>`; never use `--force` against a user project. Doctor/preflight commands: `node bin/harness-doctor.mjs --project <consumer> --json`, `node .harness/scripts/harness-workspace-preflight.mjs --workspace-root <worktree> --json`.
- Eval: `node bin/harness-eval.mjs run --suite <configured-suite-id>`; read `.harness/harness.yaml`, manifests, auth/recording profile, and `evaluate-harness` first. Model costs may apply; do not call a normal suite blind comparison.
- User-flow E2E uses `e2e-test` and its dedicated runner. Clean only run-owned resources and preserve session evidence and pre-existing files.

Implementation principles are in the owning `implement`, `tactical-code`, and `frontend-implement` GUIDE. Retired `ponytail` user config may be disabled only according to that guidance; installs preserve user settings.

## 통합 계약 버전과 CI

Product/Architecture bundle (`docs/contracts/{product.md,architecture.md,manifest.json,architecture.html,diagrams/}`) is project-owned and Git-visible. Management CI/checker files are ignored by default; projects enabling CI explicitly force-add them. Install/update preserves user-edited workflow/checker and reports conflicts. PlantUML helpers are static/offline and pin tool version/SHA.

```sh
node .harness/scripts/harness-contracts.mjs seal --root /absolute/project --summary '<변경 요약>'
node .harness/scripts/harness-contracts.mjs check --root /absolute/project --base-ref HEAD
node .harness/scripts/harness-workflow-complete.mjs --root /absolute/project --workflow <id> --base-ref <starting-commit-sha>
```

Capture starting HEAD for every run. Completion gate reads canonical review/plan/E2E/tracker records itself; caller-supplied outcome/evidence state cannot override them. It runs declared `before_complete`/contract hooks and journals under `runtime/workflow-completion/`. CI must be configured as a required status check to block merges; local completion gate is separate. Contract workflow compares PR head to base and push to prior commit.

Workflow consumer regression: `node --import ./tests/support/isolated-codex-home.mjs --test tests/intent_and_excess_guidance.test.mjs tests/plan_review_spec_paths.test.mjs tests/spec_author_runner.test.mjs tests/tactical_ticket_flow.test.mjs`. This uses fixture consumers and does not prove live-model E2E.

## Tracker 공통 lifecycle 명령

tracker 상태 전이에는 다음 공통 명령을 사용한다. root는 실제 consumer worktree의 절대 경로이며 subprocess cwd도 같은 경로다.

exact ticket 상태를 읽을 때는 다음 read-only 명령을 사용한다. GitHub는 설정된 repository와 issue number를 직접 조회하고 Project/field/item pagination이 불완전하면 누락으로 단정하지 않고 오류를 반환한다. local-markdown은 설정된 ticket 경로를 읽는다.

```sh
node .harness/scripts/harness-tracker.mjs read --root /absolute/project --ticket owner/repo#123
```

```sh
node .harness/scripts/harness-tracker.mjs check --root /absolute/project
node .harness/scripts/harness-tracker.mjs sync --root /absolute/project --ticket owner/repo#123 --status in-progress
node .harness/scripts/harness-tracker.mjs sync --root /absolute/project --ticket owner/repo#123 --status completed
```

GitHub mode는 configured Project/Workflow Status의 네 option을 확인하고 exact Issue project item만 변경한다. 기본 Status도 실행 상태에 맞추며 Issue closure는 변경하지 않는다. local-markdown mode는 configured directory 안의 ticket YAML frontmatter 상태를 바꾸고 본문을 보존한다. 참조 누락·중복·권한/API 실패는 오류다.

GitHub 발행은 승인된 본문으로 저장소 Issue를 직접 만든다. 활성화 시 plan 연결은 세션의 `runtime/to-ticket/<plan-set-id>-issues.json`에 저장한다. Project 등록·조회 실패는 경고다.

부분 성공은 `<session_directory>/runtime/tracker-sync/` journal에 기록한다. 실패 시 tracker의 실제 상태를 확인하고 재시도한다. `check`는 외부 상태를 변경하지 않는다. workspace preflight는 tracker를 조회하지 않으며 dispatch와 종료 명령은 tracker_sync를 검사한다. legacy 데이터는 migration하지 않는다.

GitHub 보드 UI는 group-by/filter를 configured Workflow Status로 선택하고 기본 Status 열을 숨긴다. view 설정은 `gh project item-edit`의 상태 갱신과 별개이며 이 CLI는 지원하지 않는 view 변경을 수행했다고 보고하지 않는다. 기존 보드·item 데이터는 이번 변경으로 재작성하지 않는다.


## 세션 파일 출력 경계

모든 로그·stdout/stderr 저장본·checkpoint·JSONL·스크린샷·평가 결과·E2E manifest·임시 파일·복구 백업은 절대 `session_directory` 아래에만 쓴다. 다음 resolver로 경로를 구하며 `/tmp`, 저장소 루트, 임의 외부 경로를 사용하지 않는다.

```sh
node .harness/scripts/harness-session-output.mjs --root <workspace_root>
node .harness/scripts/harness-session-output.mjs --root <workspace_root> --path runtime/e2e/artifacts.json
node .harness/scripts/harness-session-output.mjs --root <workspace_root> --path tmp
```

Git 프로젝트는 `<git-common-dir>/harness-workflows/sessions/<workspace-hash>/`, 비Git fixture는 `<project>/.codex/sessions/<workspace-hash>/`를 사용한다. worktree 삭제 후에도 같은 세션 경로가 남는다. 기존 데이터는 자동 이전하지 않는다. 세션은 로컬 전용이며 commit·push·tracker에 게시하지 않는다.

모든 하위 agent/tool에 `workspace_root`와 `session_directory`를 명시한다. `tmp/`를 만든 뒤 각 subprocess에 `HARNESS_SESSION_DIR=<session_directory>`, `TMPDIR`, `TMP`, `TEMP=<session_directory>/tmp`를 전달한다. 서버 로그 redirect와 browser screenshot/trace/download/output directory도 resolver가 반환한 `runtime/<작업>/` 아래로 지정한다. 출력 위치를 지정할 수 없는 도구는 task 소유 artifact가 경계 밖으로 생기는지 확인하고, 제어할 수 없으면 실행을 멈추고 제약을 보고한다. 외부 도구 자체의 전역 cache/telemetry까지 OS sandbox로 차단하는 기능은 아니다.

승인된 source·Spec·통합 계약·렌더된 제품 다이어그램·지식 registry는 선언된 최종 프로젝트 경로에 둔다. Git 원장과 설치 관리 metadata는 각 도구의 관리 경로를 유지한다. 이것을 로그 출력 우회로 사용하지 않는다. 경로 탈출·symlink·공유 hardlink 출력 대상은 공통 resolver가 거부한다.

## 테스트·서비스 실행 계약

활성 worktree의 `implementation-guidance.md` / `testing-guidance.md`를 각각 구현/실행 전에 읽는다. 관리 worktree의 추적 사본이 정본이며 workflow branch와 함께 review/push된다. 지침이 승인 Spec이나 실행 계약과 충돌하면 caller에게 보고한다.

Unit/regression checks use the project's native CLI. `execution.json` and `harness-exec` are only for explicit end-user E2E; this source has no such profile. Each E2E profile uses `purpose: "e2e"` and real configuration/readiness checks.

```sh
node .harness/scripts/harness-exec.mjs --root <workspace_root> --profile <e2e-profile-id>
```

Each run validates workspace/env/argv, prepares and verifies current config, waits for dependencies, then runs the exact command. Never reuse readiness/prepare receipts; missing profiles block. Keep this document and profile in sync.

Receipt `runtime/execution/<profile-id>-<run-uuid>/receipt.json` records command-time HEAD, dirty paths, timestamps, and config hashes. The final gate requires a passing latest receipt on current HEAD/ancestor with unchanged config and no later non-document edits; receipts without HEAD do not count.

### 프로필 계약

- `schema_version: 1`; `profiles.<id>` has `purpose: "e2e"`. No E2E means an empty `profiles` object.
- `command`: exact argv array (never shell-assembled); list required config/profile/host/port/URL args. Environment interpolation is per argv and empty values block launch. Keep secrets in env where possible.
- `required_env`: required nonempty process variables; do not infer defaults or load `.env` implicitly. Declare dotenv loading in argv and verify actual loaded config.
- `config_inputs`: workspace-relative source/manifest files, at least one. Hash them after prepare; block if verification/readiness changes them. Never put secret values in receipts.
- `prepare`: rerunnable argv, or `[]` with rationale. Never add destructive migrations/resets. `verify_config` uses project commands to compare actual targets/settings with current inputs; file existence or stale receipts are insufficient.
- `dependencies`: full service prerequisite list with purpose-appropriate authenticated/schema/queue readiness checks, not merely open ports. Timeout blocks command execution; use `[]` only when truly dependency-free.
- `timeout_ms`, `readiness_timeout_ms`, `poll_interval_ms`: positive integers matched to service/test limits.

Start declared infrastructure first and keep it alive for the server/test profile. Do not install, substitute, reset, or detach undeclared services. Declare exact infra arguments; server profiles check infra readiness and E2E profiles check both infra and server. Only stop resources this runner started.

On failure/timeout/cancel, stop only the owned process group; after SIGKILL/power loss, inspect ownership before cleanup. Keep logs/results/hashes under `session_directory/runtime/execution/<profile-id>-<run-id>/`. Test failure is `failed`; preparation failure is `blocked`.

이 저장소의 일반 Node.js 검증은 `package.json`의 기본 CLI 명령과 최소 Node 버전을 사용한다. 임시 Git/file fixture만 사용하므로 별도 서버·DB profile은 없다. 이 사실을 서비스가 있는 소비 프로젝트의 무인프라 근거로 사용하지 않는다.

### 유지보수 책임

Update EXEC when ordinary commands change; update EXEC and profile together when E2E args/env/infra/config changes. Review profiles against entrypoint, compose/manifest and config loader. The runner enforces declared inputs but cannot infer omitted business dependencies or OS-block direct shell use.

Hash baseline is after prepare; later config mutation blocks launch. POSIX cleanup covers process groups; native Windows stops only direct children, so use WSL/POSIX when descendants must be cleaned up.

## Fresh Spec 리뷰 검사

`spec-review-check`는 review 입력 고정·재검토 한도·diagram 순서/gate·설치/Git 회귀를 임시 fixture로 검사한다(`npm test`, 별도 서비스 불필요). `harness-spec-review.mjs snapshot|check`로 현재 입력과 session 보관 리뷰를 대조하고, source/Spec/diagram/용어 변경 후에는 fresh pass를 얻는다. Architecture 리뷰는 최초 1회와 재검토 최대 2회이며 dispatch 이후 중단/기록 실패도 회차를 소비한다. 준비 abort 3회 뒤에는 `resolve --reason`으로 복구를 기록하고, substantive 회차 소진 뒤에는 사용자 범위/결정 변경 전 재시작하지 않는다. 활성 attempt에 대한 reviewer dispatch identity와 실제 JSON 응답은 native SubagentStop 기록과 대조한다.

## 설치·업데이트 회귀 검사와 스킬 갱신

`node .harness/scripts/harness-context.mjs --entry`는 현재 디렉터리의 Git 등록과 정본 `worktree.json`을 확인해 workflow 진입·재개를 안내한다. 승인 지점에서는 현재 대화의 provider 기록으로 사용자 응답을 확인한다. 프로젝트 갱신은 이전 시작 훅을 백업한 뒤 등록을 제거한다. Codex 사용자 전역 등록은 다른 checkout도 이용하므로 해당 checkout을 갱신한 뒤 Codex의 `$setup`에서 정리한다. Claude Code의 Agent admission과 서브에이전트 lifecycle, Codex의 subagent identity와 쓰기 보호는 별도 훅으로 유지한다.

setup은 확인한 context window·예상 토큰·handoff reserve를 `.harness/context-budget.json`에 저장한다. `harness-stage-runtime.mjs budget`은 기준/hash를 반환하고 예상치와 관측 사용량을 구분한다. Doctor 검사 대상이며 installer는 덮어쓰지 않는다.

`model-binding-check`, `internal-skills-check`, `harness-stage-runtime.mjs binding|validate-return` cover skill inventory, install/Doctor/Git visibility, binding, and session return artifacts. They do not spawn agents or change trackers. Installer/Doctor Node checks use `node --test`; Python CLI checks use `python3 -m unittest`; fixtures and logs stay in session storage.

범위/설치 소비자 회귀는 `node --import ./tests/support/isolated-codex-home.mjs --test tests/intent_and_excess_guidance.test.mjs tests/review_scope_guard.test.mjs tests/implement_wrapper_consumer.test.mjs tests/legacy_installer_update.test.mjs`로 실행한다. 임시 CODEX_HOME, 설치/update/Doctor/Git 가시성을 검사하며 실제 모델 판단을 증명하지 않는다.

install/update 모두 같은 관리 자산 동기화를 사용한다. 관리 스킬과 refs/scripts는 기본 갱신에서도 기존 내용을 session/runtime/installer-backups/<id>/에 먼저 백업한 뒤 교체한다. `--force`는 스킬을 포함해 선택된 나머지 관리 자산의 로컬 변경도 백업 후 교체한다. agent, workflow/runtime, 관리 CI·PR template 등 나머지 자산은 기본적으로 로컬 변경을 보존한다. 재설치로 lock을 먼저 다시 만들거나 개별 스킬을 수동 복사하지 않는다. partial install은 다른 scope의 baseline을 유지한다. `.harness/harness.yaml`은 프로젝트 소유이므로 force에서도 변경하지 않는다. upstream에 없는 lock 항목은 원장만 정리하고 기존 파일은 보존한다.

doctor의 eval.permission_profile은 Harness 실행 event의 식별자이며 native profile 존재 증명이 아니다. 실제 eval 호출의 --sandbox와 sandbox_workspace_write.network_access 정책을 검증하고, eval.codex.command의 --permission-profile/-P 및 agent의 명시적 permission_profile 참조가 있으면 native inventory를 별도로 확인한다. 명시적 native 참조 누락/미검증과 위험하거나 모순된 sandbox/network 설정은 계속 실패한다. [공식 CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli)와 [설정 reference](https://learn.chatgpt.com/docs/config-file/config-reference)를 근거로 내부 label과 실제 native 설정을 구분한다.

## 구현 준비 회귀 검증

`npm test`는 profile/contract 형식과 install/Doctor 회귀를 임시 Git fixture로 검사한다. `tracker-lifecycle-check`와 `plan-review-check`는 해당 lifecycle gate를 검사한다. 구현 진입은 `harness-workspace-preflight.mjs --workspace-root <workspace_root> --for-implementation --json`으로 확인하며 실행을 시작하지 않는다. Source snapshot drift만 최종 contract sync까지 지연할 수 있다.

## E2E 실패의 재발 방지

E2E caller/runner는 `.harness/internal-skills/e2e-test/references/failure-learning.md`를 따른다. raw 증거는 세션 `runtime/e2e/<run_id>/`에 시도별로 보존하고, 확인된 재발 방지 지식은 소비 프로젝트의 `docs/verification/e2e-lessons.md`와 실제 EXEC/execution.json·회귀 검사에 반영한다. 다음 실행 전에 관련 현행 lesson과 예방 검사를 읽는다. checkpoint의 `tests.e2e_failures`는 실패 ID별로 유지하고, 원본 증거는 교체하지 않으며 예방 조치/재검증이 없는 항목은 테스트 요약이 passed여도 완료하지 않는다.

`e2e-learning-check` uses Node fixtures to verify failure retention and separate test verdict from pending learning; it starts no app/services.

## 명세·계획·구현 추적 회귀 검사

`npm test` verifies current-input review snapshots, impact reports, and dispatch gates using Node fixtures; service setup is unnecessary. Plan contracts hold the verification scenarios; independent review checks semantic coverage and whether profiles actually run the named tests.

## VictoriaLogs 개발 관측성 설치

`harness-victorialogs.mjs setup`은 Collector·VictoriaLogs·VictoriaMetrics, Spring 개발 설정과 공식 MCP를 준비한다. 기본은 bridge network, port 9428/8428/4318, 7일 보존이다. Host publish는 `127.0.0.1`; app→Collector는 localhost, backend client→서비스는 compose DNS, WSL scrape는 `host.docker.internal:<port/path>`를 쓴다. Vector/Fluent Bit 및 session JSON tailing은 사용하지 않는다. 개발 계측은 production artifact에서 제외하고 SDK/agent 중복 export를 막는다.

`harness-victorialogs.mjs start|check|stop`으로 관리한다. `check`는 API readiness만 확인하며 실제 수집은 앱 로그 검색과 service별 최신 `up=1`로 검증한다. 이 Node 저장소에는 Spring 앱이 없으므로 fixture/offline 검사만 보고하고 앱 수집을 주장하지 않는다. MCP Docker는 on-demand stdio subprocess다. 전역 provider 설정을 자동 변경하거나 Docker/image/app을 검증 명목으로 자동 시작하지 않는다. Docker daemon/Compose v2가 필요하며 데이터와 로그는 session 안에 둔다.

## Spring Boot diagnostic v1 검증

`diagnostic-log-check` (`npm test`)는 v1 일곱 이벤트, 필수 Resource/Attributes, 타입, trace, timestamp 및 offline JSONL CLI를 검사한다. Consumer setup은 schema/examples/mapping과 `victorialogs-diagnostic-logs` profile을 설치하고 `HARNESS_DIAGNOSTIC_LOG_FILE`을 실제 emitter 원본 JSONL로 지정한다. 원본 typed value와 VictoriaLogs 저장 후 string 표현을 구분한다. Unit 검사나 failure learning을 위해 E2E를 추가하지 않는다.

### WSL·Docker Desktop 네트워크 검증 근거

2026-10-22 probe는 known HTTP 응답으로 WSL↔bridge 공개 port와 `host.docker.internal` 경로를 확인했다. Alpine httpd 시도는 실행 파일 부재로 무효였으며 WSL localhost와 Docker host localhost는 같다고 가정하지 않는다. 별도 synthetic OTLP/metrics 검증은 Collector→VictoriaLogs 검색과 scrape `up=1`을 확인했으나 실제 Spring emitter, Java agent, MCP handshake는 아니었다. 임시 자원은 정리하고 evidence는 session에 보존했다.

## Codex native setup UI

`$setup`은 `node .harness/scripts/harness-setup.mjs --root <workspace_root> --start`로 시작한다. 이후 `answers_path`를 `--answers`로 넘기고 `ui_questions`를 그대로 표시한다. Rollout은 `--bind-ui`, 원문 답변은 `--receive`로 연결하며 CLI가 배치·호출 ID·누적 응답을 session에 기록한다. 최종 확인 전 프로젝트 파일을 쓰지 않으며 취소는 `--cancel`, 일반 workflow는 읽기 전용 `--check`를 쓴다. Terminal CLI를 유지한다. 상세 절차는 [설정 선택](../../.codex/skills/setup/references/native-choices.md).

## 구현 리뷰 회귀 검사

`implementation-review-check` / `npm test`는 plan별 수정 한도, 재개/worktree 교체, 리뷰 분류·gate, 통합 리뷰 조회, planning snapshot drift와 설치/Git 가시성을 임시 fixture로 검사한다. 한도 reset에는 새 계획 리뷰와 dispatch를 통과한 snapshot 변경이 필요하다. Service setup은 없다.

### 소비자 테스트 저장소의 workflow 재실행

Claude Code 비대화식 실행/재개는 대상 저장소를 cwd로 `node .claude/harness/scripts/harness-claude-orchestrator.mjs '/orchestrator <요청>'` 또는 `... --resume '<session-id>' '/orchestrator <요청>'`을 사용한다. 이 wrapper는 메인 Claude에 `bypassPermissions`를 지정하므로 명시적으로 승인된 작업에만 쓴다. Stage 권한은 별도 실행 계약을 따른다. `session_verified: false`면 세션 확인을 요구하는 workflow를 대기한다.

사용자가 소비자 workflow 재실행을 요청하면 `/home/jiwoo/workspace/harness-test`가 Git `main`의 clean 상태인지, 설치된 Harness 버전과 Doctor 결과가 적절한지 먼저 확인한다. 기존 linked worktree 정리는 명시적으로 요청된 경우에만 수행한다. 삭제 전 각 worktree의 tracked·untracked 변경과 `.io`를 포함한 전체 내용을 백업하고 백업을 검증한다. 다른 저장소의 worktree는 건드리지 않는다.

workflow-compose는 Git 공통 디렉터리의 `.git/harness-reservations/`에 lock을 만들고 linked worktree를 생성한다. 이 테스트의 **상위 `codex exec`는 쓰기 제한이 없는 환경에서** `--sandbox danger-full-access`로 실행한다. 바깥 sandbox가 Git 공통 디렉터리 쓰기를 막으면 이 옵션만으로 해제되지 않으므로 실행 전 쓰기 가능 여부를 확인하고, 막혀 있으면 재시도나 상태 수정 없이 사유를 보고한다. stage 실행은 각 스킬의 기존 실행 계약을 따른다.

Codex 테스트 전에 `/hooks`에서 서브에이전트 식별 훅의 신뢰 상태를 확인한다. 현재 대화 ID와 워크트리는 `harness-context.mjs --entry`에서 대조하며, 관찰 로그의 `thread.started` 값을 임의로 주입하지 않는다. 명시적으로 검토한 자동화에서 신뢰 설정을 사용할 수 없다면 상위 `codex exec`에만 `--dangerously-bypass-hook-trust`를 추가할 수 있다. 이 옵션은 활성 훅 전체의 신뢰 확인을 우회한다.

## Harness workflow E2E 정본 시나리오

정본 소비자 저장소는 `/home/jiwoo/workspace/harness-test`다. 다른 세션에서도 이 저장소를 사용하고, 경로가 없으면 `git@github.com:omegafrog/harness-test.git`의 checkout을 찾거나 다시 clone한다.

2026-11-05 사용자 지시: Harness를 테스트하라고 요청받으면 아래 black-box E2E를 기본 실행한다. 단위 테스트·설치 fixture·eval replay로 대체하지 않는다. 테스트 대상·원문 프롬프트·시작/종료 단계를 임의로 줄이거나 다른 작은 기능으로 바꾸지 않는다.

1. Harness 소스의 승인된 변경을 커밋하고 configured upstream에 push한다. 원격 branch에서 해당 commit이 조회되는지 확인한 뒤 `/home/jiwoo/workspace/harness-test`의 Harness를 갱신하고 Doctor를 확인한다.
2. 사용자가 기존 worktree 삭제를 요청한 경우 테스트 저장소에 등록된 linked worktree 전부를 조사한다. 각 경로의 HEAD·branch·Git status·전체 tracked/untracked/ignored 내용과 `.io`를 source session에 백업하고 hash를 검증한 뒤 제거한다. primary checkout과 다른 저장소는 삭제하지 않는다. 새 테스트가 만든 worktree는 종료 뒤 산출물 검증을 위해 보존한다.
3. `/home/jiwoo/workspace/harness-test`가 clean `main`인지 확인하고 start HEAD, installed version/lock, settings, hooks를 기록한다. Existing linked worktrees are backed up/deleted only on explicit user request; preserve all other repositories. Source push/update/Doctor are prerequisites; consumer settings are not modified.
4. Use the checklist's launch environment and exact prompts. If an existing matching workflow is found, wait for the real user choice. After choosing new, verify execution ID, Git inventory, canonical `worktree.json`, and binding; never guess a missing worktree path.
5. In the returned worktree, resume the user prompt and observe requirements, tactical design, then `tactical-to-code` through implementation. Stop after successful implementation and inspect outputs.
6. Do not answer, delegate, edit, recover, or relaunch on a question, approval wait, failure, or interruption. Preserve raw response, time, stage, session, and evidence. Only actual user input may continue the workflow.
7. Verify requirements/approval/diagram/context artifacts, scoped revision behavior, tactical model/service/integration/ADR and domain gate, and code decisions/assembly/design gate/code/tests/completion. File presence or agent success text alone does not prove completion.

## Headless Codex E2E 실행 체크리스트

Harness black-box observer는 parent/invocation에서 지정된 정확한 Harness source checkout root의 이 파일을 **모든 host `codex exec` launch argv 구성 직전과 각 `codex exec resume` argv 구성 직전마다** 다시 읽는다. 대상 consumer/worktree의 EXEC는 앱·테스트 runtime 설정을 위해 별도로 읽으며, 이 checklist를 대체하지 않는다. 지정 경로나 절이 없거나 읽히지 않으면 launch/resume하지 않고 blocker를 보고한다. 아래 binding·permission은 이 사용자 승인 black-box 시나리오만을 위한 것이다.

모든 shell의 cwd는 consumer checkout 또는 검증된 반환 worktree다. 각 launch와 resume shell에서 `CLAUDE*`를 제거하고 환경을 다시 export·검증한다. Binding은 `{"provider":"codex","model":"gpt-6-luna","reasoning_effort":"medium"}`; session은 `node .harness/scripts/harness-session-output.mjs --root <workspace_root>`로 확인한 절대 경로다. `TMPDIR`, `TMP`, `TEMP`는 모두 `$HARNESS_SESSION_DIR/tmp`로 만들며 stdin은 `/dev/null`로 닫는다. Logs, stderr, response, invocation evidence stay under source session `runtime/e2e/<run_id>/`; preserve target `.io` and workflow artifacts.

```bash
unset $(compgen -e | grep '^CLAUDE')
export HARNESS_WORKFLOW_BINDING='{"provider":"codex","model":"gpt-6-luna","reasoning_effort":"medium"}'
export HARNESS_SESSION_DIR='<session resolver absolute path>'
export TMPDIR="$HARNESS_SESSION_DIR/tmp" TMP="$HARNESS_SESSION_DIR/tmp" TEMP="$HARNESS_SESSION_DIR/tmp"
mkdir -p "$TMPDIR"
node -e 'const p=require("node:path"),e=process.env,b=JSON.parse(e.HARNESS_WORKFLOW_BINDING); if(b.provider!=="codex"||b.model!=="gpt-6-luna"||b.reasoning_effort!=="medium"||!p.isAbsolute(e.HARNESS_SESSION_DIR)||[e.TMPDIR,e.TMP,e.TEMP].some(x=>x!==p.join(e.HARNESS_SESSION_DIR,"tmp"))) process.exit(1)' || exit 1
```

첫 두 호출은 아래의 정확한 prompt와 `--json --model gpt-6-luna`, reasoning `medium`, `approval_policy="never"`, auto-compact 140000, `features.subagent_default_context_limits=false`, `--sandbox danger-full-access`, `-C <workspace>`를 사용한다. stdin은 `</dev/null`로 닫는다. Hook 신뢰를 검토한 경우에만 hook bypass를 추가한다.

`codex exec resume`은 `--sandbox`, `--add-dir`, `-C`를 받지 않는다. resume은 대상 worktree를 cwd로 실행하고 아래 override를 항상 포함한다. 실제 사용자 응답만 prompt에 넣는다.

```bash
codex exec resume --json --model gpt-6-luna \
  -c 'model_reasoning_effort="medium"' -c 'approval_policy="never"' \
  -c model_auto_compact_token_limit=140000 -c features.subagent_default_context_limits=false \
  -c 'sandbox_mode="danger-full-access"' <thread-id> '<실제 사용자 응답>' </dev/null
```

resume 전에도 위 환경 변수를 다시 export·검증하고 session tmp를 만든다. `codex exec --help`와 `codex exec resume --help`를 확인해 설치된 CLI가 각 명령에 필요한 옵션을 지원하는지 검증한다. 실제 실행 인자, cwd, prompt, exit code를 `resume-<stage>-invocation.json`에 기록하고, 세션/binding은 `.io/worktree.json`, `runtime/orchestrator/state.json`, `subagents.jsonl`와 대조한다. 도움말에 없는 옵션을 추측하거나 권한을 넓히지 않는다.

관찰자는 대상 workflow를 종료하거나 자동 복구·재실행하지 않는다. 사용자 질문·승인 대기에서는 실제 사용자 응답을 기다린다. `approval_policy="never"`는 이 명시적 시나리오에 한정되며 unrelated workflow/profile에 복사하지 않는다.

Codex 비교 설정의 자동 압축 임계값은 140,000이며 `features.subagent_default_context_limits=false`도 기록한다. 일반 프로젝트는 자체 설정을 사용한다.

```bash
codex exec --json --model gpt-6-luna -c 'model_reasoning_effort="medium"' -c 'approval_policy="never"' -c model_auto_compact_token_limit=140000 -c features.subagent_default_context_limits=false --sandbox danger-full-access \
  -C /home/jiwoo/workspace/harness-test '$orchestrator 계산기 웹 앱 만들어. 유저 인증과 커뮤니티 기능 있어야 해' </dev/null

codex exec --json --model gpt-6-luna -c 'model_reasoning_effort="medium"' -c 'approval_policy="never"' -c model_auto_compact_token_limit=140000 -c features.subagent_default_context_limits=false --sandbox danger-full-access \
  -C '<첫 응답으로 받은 생성 worktree 절대경로>' '$orchestrator 계속 진행해' </dev/null
```

질문이 workflow 생성 전 발생해도 resume에 binding을 전달하고, 생성 후에는 canonical `worktree.json`과 대조한다. Prompt를 바꾸거나 승인 문구를 덧붙이지 않는다. 전용 runner가 실제 Codex를 직접 실행하며 일반 app E2E/profile이나 내부 stage CLI로 대체하지 않는다.

Resume invocation evidence and stage identity are recorded as specified in the checklist above; do not build resume argv from a previous shell's environment.

사용자가 이번 실행에서 UI를 보류하거나 승인한 계획에 UI 변경이 없으면 `tactical-ui`에서 적용 여부만 기록한 뒤 `tactical-api`와 `tactical-data`를 진행한다. UI가 포함되면 핵심 화면·흐름에 대한 사용자 결정을 기록한 후 독립 frontend design을 시작한다. 설치 소비자의 보류·인계 회귀는 `node --import ./tests/support/isolated-codex-home.mjs --test tests/tactical_implementation_stages.test.mjs`로 검사한다.

로그·stderr·마지막 응답·프로세스 종료 코드·artifact snapshot/cleanup 결과는 Harness source session의 `runtime/e2e/<run_id>/`에 단계별로 보존한다. 생성 worktree의 정본 `.io`와 최종 source·Spec·계획·계약·다이어그램은 테스트 산출물로 보존한다. 임의 timeout으로 살아 있는 workflow를 끊지 않고, 명시된 제한이 만료되면 timeout으로 보고하며 자동 재시도하지 않는다.

사용량과 호출 분석을 함께 보고할 실행에서는 `HARNESS_E2E_TELEMETRY=1`을 지정하거나 사용자 요청의 분석 선택을 runner에 전달한다. `0` 또는 미설정의 기본 동작은 분석 끔이다. 같은 run의 재개에 선택값을 유지한다. 켜진 실행은 종료·실패·승인 대기 지점의 provider 기록을 [E2E 사용량 분석](../../.harness/internal-skills/e2e-telemetry/GUIDE.md)으로 집계해 `telemetry.md`와 `telemetry.json`을 보고한다. Claude Code의 별도 비교 실행에서 140,000 토큰을 사용하려면 부모 프로세스를 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=140000`으로 실행하고 수집 명령에 `--provider claude-code`를 넘긴다. 각 provider의 토큰과 캐시 기록은 같은 provider에서 전후를 비교한다.

### Orchestrator 작업 실행

메인 orchestrator는 [실행 조율 지침](../../.codex/skills/orchestrator/references/coordination.md)에 따라 입력 준비, model binding, 출력 스키마, 상태 기록, 반환 검증을 각각의 명령으로 수행한다. 각 실행은 새 execution ID를 사용한다. linked worktree의 shared guidance는 같은 Git common directory인지 입력 검증으로 확인한다. 오류 로그는 해당 execution의 session에 보존한다.

stage 실행은 `.codex/skills/orchestrator/references/dispatch.md`에 따라 native 서브에이전트를 시작하고 종료를 기다린다. 서브에이전트의 작업 규칙은 agent profile의 `Harness stage contract`에 있어 공통 문서를 따로 읽지 않는다. 결과 JSON은 `bind`가 돌려준 `receive_command`의 표준 입력으로 제출한다. 실행기는 현재 실행과 실제 작업자 ID를 확인해 출력 파일을 정한다. `finish`는 출력 형식과 실행 상태를 검증하고 결과를 기록한다.


결과는 `harness-native-stage.mjs finish`의 반환값과 정본 실행 상태에서 확인한다. 실패나 중단이 확인되기 전에는 같은 stage를 다시 시작하지 않는다.


구성된 workflow의 입력과 실행 ID는 `harness-native-stage.mjs launch`(입력 준비 `harness-prepare-input.mjs`와 예약 `start`를 한 번에 실행)가 생성한다. 출력은 기본이 compact이고 `--verbose`가 전체 입력·결과를 출력하며, 모든 오류는 `why`와 `next` 또는 `user_decision`을 가진 JSON 하나다. 최초 workflow-compose의 worktree는 `harness-compose-workspace.mjs`가 준비한다.


workflow-compose 진입의 worktree 생성은 `harness-compose-workspace.mjs`가 기존 lifecycle 코드로 수행한다. 생성된 작업 위치와 session 출력만 이후 stage의 쓰기 경로가 되며, agent는 `context.worktree_ref`의 정본 기록을 읽고 preflight·문서 작업을 수행한다.

stage의 사용자 질문은 `USER_DECISION_REQUIRED`와 `questions`로 반환된다. 사용자 답변은 `harness-native-stage.mjs launch --stage-id <stage> --answer <question_id 포함 JSON>`(또는 `harness-prepare-input.mjs`)로 전달하며, 준비기는 질문 ID와 답변을 확인해 이전 결과와 함께 새 서브에이전트 실행의 입력으로 만든다.

## Stage 실행 환경

stage는 오케스트레이터 CLI(Codex 또는 Claude Code)의 native 서브에이전트로 실행되며 별도 CLI 프로세스를 띄우지 않는다. 서브에이전트의 sandbox와 권한은 해당 agent profile과 오케스트레이터 세션의 설정을 따르고, Harness가 stage마다 `--add-dir` 같은 권한을 따로 조립하지 않는다.

GitHub tracker를 쓰는 `implement-wrapper`에는 네트워크 접근이 필요하다. 연결 실패를 토큰 무효로 단정하기 전에 해당 서브에이전트의 sandbox 네트워크 설정을 확인한다. local-markdown mode에는 이 설정이 필요 없다.

Harness black-box 관찰자는 내부 stage 실패나 모델 자체 복구를 이유로 외부 `codex exec`·`claude -p` 세션이나 timeout wrapper에 종료 신호를 보내지 않는다. 그 동작을 관찰·기록하며, 관찰자의 종료는 사용자의 명시적 취소 지시가 있을 때만 허용한다. 서브에이전트는 부모 세션 안에서만 실행되므로 부모 세션을 종료하면 실행 중인 stage도 함께 사라진다. 앱·인프라 cleanup 권한은 테스트 대상 workflow를 종료할 권한이 아니다.

정적 실행 위치·발행 본문 생성의 설치 소비자 회귀는 `node --test tests/execution_workspace.test.mjs`로 실행한다. 일반 회귀이며 실제 workflow E2E의 대체가 아니다.

발행 상태 회귀는 `node --test tests/execution_workspace.test.mjs`로 검사한다. configured Project를 유일한 발행 상태로 조회하며 기존 publish-state.json 변조·본문 끝 개행·중복 항목·본문 변조와 설치/업데이트 Git 가시성을 확인한다.

GitHub 티켓의 사전 점검과 상태 변경은 Project ID, Workflow Status/Status 필드와 옵션 ID를 Worktree의 `.io/runtime/tracker-cache/`에 최대 1시간 보관한다. 티켓의 실제 상태는 매번 GitHub에서 읽는다. 필드 불일치나 쓰기 실패 시 캐시를 버려 다음 실행에서 다시 조회한다. 캐시가 없으면 최초 메타데이터 조회에 GitHub 호출 한도가 필요하다.
