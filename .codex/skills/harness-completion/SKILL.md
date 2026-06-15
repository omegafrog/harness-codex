---
name: harness-completion
description: Install or inspect harness shell completion through the runtime CLI. Use when the user asks for tab completion, shell completion setup, completion troubleshooting, or `harness completion install`.
---

# Harness Completion

## Command Map

- `./harness completion install [--shell auto|zsh|bash|all]`

## Procedure

1. Detect shell from `$SHELL` when user did not specify one.
2. Run install command from repo root.
3. If troubleshooting, inspect `scripts/harness-completion.bash`, `scripts/harness-completion.zsh`, and `docs/runtime-shell-completion.md`.
4. Verify with `bash scripts/test-harness-completion.bash` when behavior changed.
