---
name: setup
description: Initialize a repository for the harness workflow. Use when setting up a repository for the first time, when CONTEXT.md or CONTEXT-MAP.md is missing, when agent model tiers have not been chosen, or when tracker configuration has not been chosen.
---

# Harness Setup

Initialize repository-owned context, agent model tiers, and tracker settings before running `spec-me` or `to-ticket`.

## Context Files

1. Treat the current working directory as the repository root.
2. If `CONTEXT.md` is missing, create it from `assets/CONTEXT.md`.
3. If `CONTEXT-MAP.md` is missing, create it from `assets/CONTEXT-MAP.md`.
4. Never overwrite either file. Ask the user to resolve any requested replacement.
5. Tell the user which files were created and which existing files were preserved.

When later architecture work establishes reusable models, link `docs/architecture/domain-model.md` from `CONTEXT-MAP.md` under the DDD model continuity contract; do not seed imaginary aggregates during setup. Verification maps belong to the consumer project and can be seeded/maintained with `maintain-verification`; launch/server configuration remains in `docs/agents/EXEC.md`.

## 실행 계약 준비

실제 테스트/서버/인프라 entrypoint·필수 인자·config loader·compose/CI를 조사해 `docs/agents/EXEC.md`의 실행 계약과 `docs/agents/execution.json`을 작성한다. 각 프로필은 정확한 command, required_env, config_inputs, prepare, verify_config, dependencies 및 timeout/poll 값을 포함한다. 필요한 설정 갱신과 실제 readiness를 검증하는 프로젝트 명령을 사용한다. 인프라/prepare 불필요의 근거를 EXEC에 기록한다. 기존 사용자 프로필은 보존하고 Harness 원본의 명령을 소비 프로젝트에 복사하지 않는다. 불명확한 값은 질문하여 해결하기 전 서버/테스트를 시작하지 않는다.

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

Ask model questions after context initialization and before tracker setup. Ask one question at a time:

1. Inspect the current Codex runtime/tool schema and list the currently available subagent model choices.
2. Show every available model to the user in Korean, including its capability and reasoning-effort choices when the runtime provides them.
3. Ask in Korean: `Product/Architecture 결정, 복잡한 코드 추론, 최종 Spec 검증 같은 고성능 작업에 사용할 모델을 선택해 주세요.`
4. Recommend the most capable available model for high-performance work.
5. Ask in Korean: `승인된 plan의 코드 작성, 테스트 수정, 일반 구현 검증에 사용할 모델과 reasoning effort를 선택해 주세요.`
6. Recommend `high` reasoning effort with a lighter capable model for implementation; never hardcode a model ID.
7. Ask in Korean: `실제 E2E 테스트, 서버 실행, 로그 확인, 결과를 받을 때까지 polling하는 작업에 사용할 모델과 reasoning effort를 선택해 주세요.`
8. Recommend a balanced agentic model and moderate reasoning effort for execution and polling.
9. Ask in Korean: `문서 직렬화, 다이어그램 생성, 제한된 읽기 전용 조사 같은 저성능 작업에 사용할 모델과 reasoning effort를 선택해 주세요.`
10. Recommend the lightest available model and lowest supported reasoning effort for low-performance work.
11. Do not use a hardcoded or stale model list; use only choices available in the current runtime.
12. Require explicit model and reasoning-effort selection for all four roles. If the user skips a choice, keep asking that role's question before tracker setup.
13. If the user chooses all four models and reasoning efforts, create or update `.codex/harness.yaml` with:

```yaml
agents:
  high_performance_model: "<selected high-performance model>"
  high_performance_reasoning_effort: "<selected high-performance reasoning effort>"
  implementation_model: "<selected implementation model>"
  implementation_reasoning_effort: "<selected implementation reasoning effort>"
  execution_model: "<selected execution model>"
  execution_reasoning_effort: "<selected execution reasoning effort>"
  low_performance_model: "<selected low-performance model>"
  low_performance_reasoning_effort: "<selected low-performance reasoning effort>"
  default_model: "<selected low-performance model>" # legacy fallback
```

14. If `.codex/harness.yaml` already exists, preserve unrelated keys. Update the eight role/model-effort keys and synchronize legacy `agents.default_model` to the selected low-performance model.
15. Downstream skills must use the matching role: `agents.high_performance_model` for high-performance decisions, `agents.implementation_model` for normal implementation, `agents.execution_model` for E2E/server execution and polling, and explicit `agents.low_performance_model` overrides for lightweight subagents. `agents.default_model` exists only for older skills/configurations.

### Selection interaction contract

- Render a numbered, selectable list from the current runtime schema before the first model question. Each option must show exact model ID, capability label, and supported reasoning efforts when available.
- Mark existing configured values as `현재값`, but never accept them silently. User must confirm or choose another model for each tier.
- Accept the option number or exact model ID, then accept a reasoning-effort option supported by that model. Reject values not present in the current runtime list and repeat the same role question.
- After each selection, render the same list again for the next role and mark already selected models. Selecting the same model is allowed, but recommend the most capable model for high-performance work, `high` reasoning with a lighter capable model for implementation, a balanced model for execution/polling, and the lightest model for low-performance work.
- Show final selection summary in Korean and get confirmation before writing `.codex/harness.yaml`.

## Beads Project Board

Beads는 설정된 Harness tracker와 별도의 프로젝트 작업 보드다. 이 프로젝트에서 Beads를 사용할지 한국어로 묻는다. 사용자가 거절하면 Beads 명령을 실행하지 않는다. 이 경우 생성 ticket을 Beads에 mirror하므로 초기화된 Beads workspace 없이는 `to-ticket`을 실행할 수 없다고 안내한다.

1. Check `bd version`. If the CLI is missing, show `npm install --global @beads/bd` and stop Beads setup until it is available.
2. Run `bd where`. If this project already has a workspace, preserve it and report `bd status`; never initialize it again.
3. If no workspace is active, preserve any existing `.beads/` files and check whether `origin` contains `refs/dolt/data` with `git ls-remote origin refs/dolt/data`. If this check fails, stop and report the error; do not assume there is no remote database.
4. If remote Beads data exists, do not run `bd init`. Show `bd bootstrap --dry-run`, explain that bootstrap adopts the existing board, and get explicit approval before running `bd bootstrap`.
5. If the successful remote check finds no Beads data, inspect `.beads/` for a local database. If database files exist, stop and diagnose without overwriting them. If `.beads/` is absent or contains only configuration/metadata, get explicit approval before running `bd init --skip-agents --init-if-missing`.
6. After setup, run `bd status` from the project root.

Linked Git worktrees in the same repository share the Beads workspace through Git common-directory discovery. Do not initialize a separate board in a linked worktree or copy `.beads` into it. For a remote-backed schema migration, designate one clone to migrate and publish; every other clone adopts that result with the Beads-supported bootstrap procedure. Never migrate multiple clones independently.

## Tracker Setup

Ask one question at a time after agent model setup:

1. Choose exactly one tracker mode: `local-markdown` or `github`.
2. For `local-markdown`, ask for the ticket directory.
3. For `github`, ask for the repository and Project owner. Run `gh project list --owner <project-owner>`; let the user select an existing Project or approve creation of a new repository-specific Project with `gh project create --owner <project-owner> --title <repository>-workflow`.
4. Inspect the selected Project with `gh project field-list <project-number> --owner <project-owner>`. It must contain a `Workflow Status` single-select field with `Planned`, `In Progress`, `Blocked`, and `Done`.
5. If the field is absent, explain the change and wait for approval before running `gh project field-create <project-number> --owner <project-owner> --name "Workflow Status" --data-type SINGLE_SELECT --single-select-options "Planned,In Progress,Blocked,Done"`. Never modify another existing field or Project without approval.
6. Record the choice in `.codex/harness.yaml`:

```yaml
tracker:
  mode: github # or local-markdown
  github:
    repository: owner/repo
    project_owner: owner
    project_number: 1
    status_field: Workflow Status
    assignees:
      spec_me: "@me"
      codex: "@copilot"
  local_markdown:
    directory: .scratch/issues
```

GitHub mode에서는 assignee 매핑을 보존한다. `spec_me`는 `spec-me → to-ticket`에서 생성하는 Issue에, `codex`는 Codex가 테스트나 개발 중 생성하는 Issue에 사용한다. 그 외 설정은 변경하지 않는다. 다음 skill은 `tracker.mode`를 먼저 확인해 설정된 tracker를 ticket과 상태의 기준으로 사용한다. `to-ticket`은 ticket 생성을 Beads에도 mirror한다. setup 중에는 ticket, GitHub issue, product code를 생성하지 않는다.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

초기 setup에서 통합 계약이 없다면 기존 source·테스트·Spec을 조사하여 `sync-contracts` 형식으로 최초 bundle과 다이어그램을 생성한다. 빈 manifest나 예시 모델을 설치 프로젝트의 실제 모델로 취급하지 않는다. Product/Architecture 문서는 생성할 수 있으며 product code를 새로 만드는 것은 setup 범위가 아니다. 기존 업무 지식이 불충분하면 해당 질문과 미완료 상태를 남긴다.

## Tracker 보드 표시와 새 mirror 정책

GitHub Project의 보드 그룹과 필터는 configured `Workflow Status`를 사용하고 기본 `Status`는 workflow 기준으로 사용하지 않는다. setup 결과에 보드의 group-by를 `Workflow Status`로 선택하고 기본 `Status` 열을 숨기는 UI 설정을 안내한다. CLI가 지원하지 않는 view 변경을 성공했다고 보고하지 않는다. Project field 삭제나 기존 item 상태 migration은 하지 않는다.

신규 Beads mirror는 네 가지 lifecycle 기본 상태만 사용한다. 초기 프로젝트 설정은 `bd config set status.custom ""`로 custom status를 비워 기본 상태만 사용한다. 사용자가 따로 운영하는 custom 설정을 무조건 덮어쓰거나 기존 Issue를 migration하지 않는다. backlog 분류와 test/review 단계는 `beads` 스킬의 metadata로 분리한다. `to-ticket`이 새로 연결한 ref에만 lifecycle version marker를 기록하고 공통 sync/check를 사용한다.
