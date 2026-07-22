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

1. Choose tracker mode: `local markdown` or `GitHub`.
2. For `local markdown`, ask where ticket files belong.
3. For `GitHub`, ask which repository or issue-tracker scope to target.
4. Ask for mappings only when local labels differ from `bug`, `enhancement`, one state role, and `ready-for-agent`.

Record the confirmed tracker choice in the repository's existing planning document when one exists. Do not create tickets, GitHub issues, or product code during setup.
