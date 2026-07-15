# Agent Context

Write internal agent input/output in English. Write workflow artifact Markdown documents and user questions in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.

This repo is a Python Codex harness for ChangeSet/use-case workflows with a bundled runtime dashboard.

## Fast Context
- Repo map: `.harness/docs/agent/context.md`
- Commands and verification: `.harness/docs/agent/commands.md`
- Module-specific guidance: nearest nested `AGENTS.md`

Read only the smallest relevant context file. Prefer `rg` and targeted file reads. Use caveman or similarly brief output for routine work.
Skill descriptions are routing hints, not global mandates. Apply a skill's mandatory steps only after that skill is selected for the current turn.

## Hard Rules
- Internal agent input/output must be written in English. Workflow artifact Markdown documents, commit/PR messages, user questions, code comments, and `docs/` documents must be written in Korean. Preserve identifiers, paths, and commands.
- Use `python3` for Python commands.
- Manage dependencies with the repository-root `venv`.
- Preserve existing ChangeSet, use-case, maintenance, and plan workflow boundaries.
- Do not commit or push ChangeSet-specific workflow artifacts to `origin/main`. This includes `docs/changes/active/**`, `docs/use-cases/**/{e2e-goal.md,use-case.md,event-storming.md,ddd-design.md,technical-decisions.md,class-diagram.md,flow-diagram.md,diagram-metadata.json}`, `docs/plans/active/**`, and `.harness/runs/**`. Keep them on the active ChangeSet branch, PR branch, runtime artifact storage, or generated workspace only.
- Before pushing to `main` or `origin/main`, inspect `git diff --name-only origin/main...HEAD` and stop if it contains ChangeSet-specific workflow artifacts unless the user explicitly asks to publish those artifacts to main.
- When the current runtime payload declares `upstream_context`, inspect high-priority artifacts before acting when their stated purpose applies. These are reading-priority hints, not generic required inputs.
- Do not edit runtime code unless the task explicitly requires it.
- Do not overwrite unrelated worktree changes.
