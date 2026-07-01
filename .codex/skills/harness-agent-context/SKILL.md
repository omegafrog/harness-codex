---
name: harness-agent-context
description: Initialize or refresh repo-local harness agent context files through the runtime CLI. Use when the user asks for `harness init`, `harness agent-context init`, agent context bootstrap, repo description detection, AGENTS.md/.harness/docs/agent generation, or validation of generated agent context.
---

# Harness Agent Context

## Command Map

- Use `./harness init [--description TEXT] [--force] [--no-llm]` for the top-level convenience command.
- Use `./harness agent-context init [--description TEXT] [--force] [--llm|--no-llm]` when the user names the nested command.

## Procedure

1. Inspect existing `AGENTS.md`, nested `AGENTS.md`, and `.harness/docs/agent/` before running with `--force`.
2. Prefer dry inspection and status first: `git status --porcelain=v1` and targeted diffs.
3. Run the command from the repository root.
4. Verify generated context with:

```bash
find . -name AGENTS.md -print | sort | xargs -r wc -w
wc -w .harness/docs/agent/*.md
rg -n -P "\p{Hangul}" AGENTS.md .harness/docs/agent || true
git diff --stat
```

Documents under `docs/` must stay English. Do not overwrite unrelated worktree changes.
