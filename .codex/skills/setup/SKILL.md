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

## Harness Ignore List

Update the repository `.gitignore` with Harness-generated runtime-only artifacts.

1. Preserve all existing project-specific rules.
2. Add this rule only when it is missing:

```gitignore
# Harness runtime-only artifacts
docs/plans/.runtime/
```

3. Keep ticket-scoped Product Specs, Architecture Specs, and plan documents tracked:
   - `docs/specs/<ticket-id>/**`
   - `docs/plans/<plan-set-id>/<plan-id>.md`
   - `docs/plans/<plan-set-id>/plans.md` when `local-markdown` is selected
4. Keep repository Harness configuration and installed assets tracked:
   - `.codex/harness.yaml`
   - `.codex/agents/**`
   - `.codex/skills/**`
5. Do not add generic project rules such as `venv/`, `.venv/`, `.serena/`, or `.playwright-cli/`.
6. Do not add obsolete runtime paths such as `.harness/**`, `docs/changes/`, or `docs/use-cases/`.
7. Make the update idempotently and report whether the rule was added or already present.

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

For GitHub mode, preserve the assignee mapping: `spec_me` is used for Issues created through the `spec-me → to-ticket` flow, and `codex` is used for Issues Codex creates during testing or development. Preserve unrelated keys. Downstream skills must read `tracker.mode` first and use only that tracker. Do not create tickets, GitHub issues, or product code during setup.
