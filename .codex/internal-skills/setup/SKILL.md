---
name: setup
description: Ask the minimal initial harness setup questions: choose default subagent model, choose tracker mode, confirm scope, and capture any required label mapping.
---

# setup

## What it does

`setup` collects the initial harness configuration that later skills need before they run.

It asks one question at a time and stops after the agent model and tracker mode are clear enough to proceed.

## Questions to ask

1. Which subagent model to use by default:
   - inspect the current Codex runtime/tool schema
   - show the currently available model choices to the user
   - recommend the lightest available model for lower cost or faster execution
   - do not use a hardcoded or stale model list
   - record the choice in `.codex/harness.yaml` as `agents.default_model`
   - preserve unrelated keys when `.codex/harness.yaml` already exists
2. Which tracker mode to use, exactly one: `local-markdown` or `github`.
3. If `local-markdown`, where the ticket files should live.
4. If `github`, ask for repository and Project owner, list Projects, and let the user select or approve creating a repository-specific Project.
5. Inspect it with `gh project field-list`; require a `Workflow Status` single-select field with `Planned`, `In Progress`, `Blocked`, and `Done`. Explain and get approval before `gh project field-create`; never modify another existing field or Project without approval.
6. Record `tracker.mode`, Project owner/number, and `status_field: Workflow Status` in `.codex/harness.yaml`; downstream skills must use only that tracker.

## Output

- default subagent model, if selected
- tracker mode
- target scope or file location
- GitHub Project owner and number when GitHub is selected

## Pulled out on purpose

`setup` exists so the harness can be initialized once and downstream skills can stay focused on slicing and publishing instead of negotiating bootstrap configuration inline.
