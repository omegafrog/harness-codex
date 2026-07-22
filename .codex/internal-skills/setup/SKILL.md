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
2. Which tracker mode to use:
   - `local markdown`
   - `GitHub`
3. If `local markdown`, where the ticket files should live.
4. If `GitHub`, which repository or issue tracker scope to target.
5. If labels differ from the canonical roles, what the mapping is for:
   - `bug`
   - `enhancement`
   - one state role
   - `ready-for-agent`

## Output

- default subagent model, if selected
- tracker mode
- target scope or file location
- canonical-to-local label mapping, if needed

## Pulled out on purpose

`setup` exists so the harness can be initialized once and downstream skills can stay focused on slicing and publishing instead of negotiating bootstrap configuration inline.
