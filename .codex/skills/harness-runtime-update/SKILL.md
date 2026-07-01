---
name: harness-runtime-update
description: Update installed harness-codex runtime files through `harness update`. Use when the user asks to refresh an installed runtime, update harness runtime from origin/main or another ref, dry-run an update, skip venv refresh, or troubleshoot runtime update behavior.
---

# Harness Runtime Update

## Command Map

- `./harness update [--repo URL] [--ref REF] [--skip-venv] [--dry-run]`

## Procedure

1. Read `.harness/docs/runtime/update-command.md` when exact preservation behavior matters.
2. Prefer `--dry-run` first unless user explicitly requested execution.
3. Preserve workflow-generated artifacts and project-local config.
4. After update, inspect `git diff --stat` and report runtime version transition if shown.
5. Do not use reset to fix update issues unless user explicitly asks for reset.
