---
name: setup
description: Initialize a repository for the harness workflow. Use when setting up a repository for the first time, when CONTEXT.md or CONTEXT-MAP.md is missing, or when tracker configuration has not been chosen.
---

# Harness Setup

Initialize repository-owned context before running `spec-me` or `to-ticket`.

## Context Files

1. Treat the current working directory as the repository root.
2. If `CONTEXT.md` is missing, create it from `assets/CONTEXT.md`.
3. If `CONTEXT-MAP.md` is missing, create it from `assets/CONTEXT-MAP.md`.
4. Never overwrite either file. Ask the user to resolve any requested replacement.
5. Tell the user which files were created and which existing files were preserved.

## Tracker Setup

Ask one question at a time after context initialization:

1. Choose tracker mode: `local markdown` or `GitHub`.
2. For `local markdown`, ask where ticket files belong.
3. For `GitHub`, ask which repository or issue-tracker scope to target.
4. Ask for mappings only when local labels differ from `bug`, `enhancement`, one state role, and `ready-for-agent`.

Record the confirmed tracker choice in the repository's existing planning document when one exists. Do not create tickets, GitHub issues, or product code during setup.
