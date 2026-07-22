---
name: setup
description: Ask the minimal initial harness setup questions: choose tracker mode, confirm scope, and capture any required label mapping.
---

# setup

## What it does

`setup` collects the initial harness configuration that later skills need before they run.

It asks one question at a time and stops after the tracker mode is clear enough to proceed.

## Questions to ask

1. Which tracker mode to use:
   - `local markdown`
   - `GitHub`
2. If `local markdown`, where the ticket files should live.
3. If `GitHub`, which repository or issue tracker scope to target.
4. If labels differ from the canonical roles, what the mapping is for:
   - `bug`
   - `enhancement`
   - one state role
   - `ready-for-agent`

## Output

- tracker mode
- target scope or file location
- canonical-to-local label mapping, if needed

## Pulled out on purpose

`setup` exists so the harness can be initialized once and downstream skills can stay focused on slicing and publishing instead of negotiating bootstrap configuration inline.
