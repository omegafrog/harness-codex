# Agent Context

Write all agent input/output and user-facing output in English.

This repo is a Python Codex harness for ChangeSet/use-case workflows with a bundled runtime dashboard.

## Fast Context
- Repo map: `docs/agent/context.md`
- Commands and verification: `docs/agent/commands.md`
- Current handoff state: `docs/agent/session-state.md`
- Token-reduction report: `docs/agent/token-reduction-report.md`
- Module-specific guidance: nearest nested `AGENTS.md`

Read only the smallest relevant context file. Prefer `rg`, targeted file reads, Serena, and Graphify over broad dumps. Use caveman or similarly brief output for routine work.

## Hard Rules
- PR bodies, commit messages, and code comments must be written in Korean.
- Documents created or updated under `docs/` must be written in English.
- Use `python3` for Python commands.
- Manage dependencies with the repository-root `venv`.
- Preserve existing ChangeSet, use-case, maintenance, and plan workflow boundaries.
- When the current runtime payload declares `upstream_context`, inspect high-priority artifacts before acting when their stated purpose applies. These are reading-priority hints, not generic required inputs.
- Do not edit runtime code unless the task explicitly requires it.
- Do not overwrite unrelated worktree changes.

## PR Body Requirements
Each PR must include:
- Implementation intent
- Implementation approach
- Verification method
- Risks and rollback

Use Korean headings/content for PR bodies.

## Output Budget
- Cap routine command output near 4k tokens.
- Use concise status commands.
- Use diff stats before targeted diffs.
- Summarize logs/tests instead of pasting full output.
