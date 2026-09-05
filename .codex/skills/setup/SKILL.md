---
name: setup
description: Initialize a repository for the harness workflow. Use when setting up a repository for the first time, when CONTEXT.md or CONTEXT-MAP.md is missing, when the default subagent model has not been chosen, or when tracker configuration has not been chosen.
---

# Harness Setup

Initialize repository-owned context, default subagent model, and tracker settings before running `spec-me` or `to-ticket`.

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
   - `docs/plans/<plan-id>.md`
   - `docs/plans/plans.md` when `local-markdown` is selected
4. Keep repository Harness configuration and installed assets tracked:
   - `.codex/harness.yaml`
   - `.codex/agents/**`
   - `.codex/skills/**`
5. Do not add generic project rules such as `venv/`, `.venv/`, `.serena/`, or `.playwright-cli/`.
6. Do not add obsolete runtime paths such as `.harness/**`, `docs/changes/`, or `docs/use-cases/`.
7. Make the update idempotently and report whether the rule was added or already present.

## Agent Model Setup

Ask one question after context initialization and before tracker setup:

1. Inspect the current Codex runtime/tool schema and list the currently available subagent model choices.
2. Show the list to the user in Korean.
3. Ask which model harness subagents should use by default.
4. Recommend the lightest available model when the user wants lower cost or faster execution.
5. Do not use a hardcoded or stale model list; use only choices available in the current runtime.
6. If the user chooses a model, create or update `.codex/harness.yaml` with:

```yaml
agents:
  default_model: "<selected model>"
```

7. If `.codex/harness.yaml` already exists, preserve unrelated keys and update only `agents.default_model`.
8. If the user skips model selection, do not write a default model; downstream skills must use the lightest available model.

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
