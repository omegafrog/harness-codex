---
name: harness-completion
description: Install or inspect harness shell completion through the runtime CLI. Use when the user asks for tab completion, shell completion setup, completion troubleshooting, or `harness completion install`.
---

# Harness Completion

## Command Map

- `./harness completion install [--shell auto|zsh|bash|all]`

## Procedure

1. Detect shell from `$SHELL` when user did not specify one.
2. Run the install command from the repository root.
3. For troubleshooting, inspect the installed source selected by `harness_codex.runtime.shell_completion`:
   - Bash: `completions/harness.bash`
   - Zsh: `completions/_harness`
4. Verify candidate generation with the runtime test suite; do not source obsolete scripts from `scripts/`.
