---
name: setup
description: Initialize a repository for the harness workflow. Use when setting up a repository for the first time, when CONTEXT.md or CONTEXT-MAP.md is missing, when agent model tiers have not been chosen, or when tracker configuration has not been chosen.
---

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [implementation-guidance](../../../.codex/internal-skills/implementation-guidance/GUIDE.md) · [sync-contracts](../../../.codex/internal-skills/sync-contracts/GUIDE.md) · [testing-guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md).

# Harness Setup

Initialize repository-owned context, agent model tiers, and tracker settings before running `spec-me` or `to-ticket`. Run the interactive setup CLI first; do not ask setup choices in chat.

```sh
node .codex/scripts/harness-setup.mjs --root <absolute-project-root>
```

The CLI owns deterministic choices, validates live model options, confirms the summary, and preserves existing project files. If it fails, report its exact error and leave setup incomplete. Continue only with source-based project analysis after it succeeds. When `.codex/harness.yaml` has `observability.victorialogs.local.enabled: true`, run the installed `victorialogs-local-setup` skill as part of this setup; it is the single project-local install and app-connection path for OpenTelemetry Collector, VictoriaLogs, VictoriaMetrics, Actuator targets and two official MCP servers. The CLI collects project/service identities and both app-visible metrics_url and container-visible scrape_url for Actuator; use compose bridge with loopback-published host ports and internal service DNS. On Docker Desktop/WSL, host.docker.internal is resolved by containers, not the WSL app. Never guess service ports or install Vector/Fluent Bit. Do not leave the user with only backend templates or tell them to run a separate untracked recipe.

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
3. `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <workspace_root> --for-implementation --json`을 같은 cwd에서 재실행한다. `valid: true` 전에는 구현·구현 커밋·In Progress 전환·agent dispatch를 시작하지 않는다. 설치·업데이트는 doctor도 재실행한다. 해결할 수 없는 업무 결정이나 비밀값은 대화로 묻지 말고 정확한 차단 사유로 보고한다.
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

## Agent Model Setup

Model and reasoning-effort choices are collected by `harness-setup.mjs` from the live Codex app-server schema. Never ask the user these choices in chat or hardcode a model list. The CLI preserves unrelated `.codex/harness.yaml` keys and confirms before writing.

## Beads Project Board

Beads 사용 여부, CLI 설치, 기존 workspace 보존, 원격 bootstrap 또는 새 초기화 확인은 모두 `harness-setup.mjs`의 터미널 안에서 처리한다. setup skill은 대화로 승인·초기화를 묻지 않는다. CLI가 성공한 경우에만 project root에서 `bd status`를 확인한다. 사용자가 Beads를 선택하지 않았으면 Beads 명령을 실행하지 않으며, 해당 프로젝트의 `to-ticket`이 Beads 의존으로 막힌다는 사실을 setup 결과에 기록한다.

Linked Git worktrees in the same repository share the Beads workspace through Git common-directory discovery. Do not initialize a separate board in a linked worktree or copy `.beads` into it. For a remote-backed schema migration, designate one clone to migrate and publish; every other clone adopts that result with the Beads-supported bootstrap procedure. Never migrate multiple clones independently.

## Tracker Setup

Tracker selection and GitHub Project field validation are performed by `harness-setup.mjs`. Do not ask tracker questions in chat or create tickets during setup. If GitHub access or API limits prevent validation, report the exact CLI error and leave setup incomplete.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

초기 setup에서 통합 계약이 없다면 기존 source·테스트·Spec을 조사하여 `sync-contracts` 형식으로 최초 bundle과 다이어그램을 생성한다. 빈 manifest나 예시 모델을 설치 프로젝트의 실제 모델로 취급하지 않는다. Product/Architecture 문서는 생성할 수 있으며 product code를 새로 만드는 것은 setup 범위가 아니다. 기존 업무 지식만으로 확인할 수 없는 규칙은 질문하지 않고 미확정·미완료로 기록해 관련 설계/구현을 차단한다.

## Tracker 보드 표시와 새 mirror 정책

GitHub Project의 보드 그룹과 필터는 configured `Workflow Status`를 사용하고 기본 `Status`는 workflow 기준으로 사용하지 않는다. setup 결과에 보드의 group-by를 `Workflow Status`로 선택하고 기본 `Status` 열을 숨기는 UI 설정을 안내한다. CLI가 지원하지 않는 view 변경을 성공했다고 보고하지 않는다. Project field 삭제나 기존 item 상태 migration은 하지 않는다.

신규 Beads mirror는 네 가지 lifecycle 기본 상태만 사용한다. 초기 프로젝트 설정은 `bd config set status.custom ""`로 custom status를 비워 기본 상태만 사용한다. 사용자가 따로 운영하는 custom 설정을 무조건 덮어쓰거나 기존 Issue를 migration하지 않는다. backlog 분류와 test/review 단계는 `beads` 스킬의 metadata로 분리한다. `to-ticket`이 새로 연결한 ref에만 lifecycle version marker를 기록하고 공통 sync/check를 사용한다.
