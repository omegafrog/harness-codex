# Agent Context

Write all agent input/output and user-facing output in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.

This repo is a Python Codex harness for ChangeSet/use-case workflows with a bundled runtime dashboard.

## Fast Context
- Repo map: `.harness/docs/agent/context.md`
- Commands and verification: `.harness/docs/agent/commands.md`
- Current handoff state: `.harness/docs/agent/session-state.md`
- Token-reduction report: `.harness/docs/agent/token-reduction-report.md`
- Module-specific guidance: nearest nested `AGENTS.md`

Read only the smallest relevant context file. Prefer `rg`, targeted file reads, Serena, and Graphify over broad dumps. Use caveman or similarly brief output for routine work.

## Hard Rules
- PR bodies, commit messages, and code comments must be written in Korean.
- Documents created or updated under `docs/` must use Korean for titles, headings, prose, table labels, statuses, findings, and user-visible examples.
- Grill-Me, use-case, event-storming, DDD, technical-decision, planning, verification, and review questions plus recommended answers must be written in Korean.
- Use `python3` for Python commands.
- Manage dependencies with the repository-root `venv`.
- Preserve existing ChangeSet, use-case, maintenance, and plan workflow boundaries.
- Do not commit or push ChangeSet-specific workflow artifacts to `origin/main`. This includes `docs/changes/active/**`, `docs/use-cases/**/{e2e-goal.md,use-case.md,event-storming.md,ddd-design.md,technical-decisions.md,class-diagram.md,flow-diagram.md,diagram-metadata.json}`, `docs/plans/active/**`, and `.harness/runs/**`. Keep them on the active ChangeSet branch, PR branch, runtime artifact storage, or generated workspace only.
- Before pushing to `main` or `origin/main`, inspect `git diff --name-only origin/main...HEAD` and stop if it contains ChangeSet-specific workflow artifacts unless the user explicitly asks to publish those artifacts to main.
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
