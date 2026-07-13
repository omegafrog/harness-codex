# Agent Context

Write all agent input/output and user-facing output in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.

This repo is a Python Codex harness for ChangeSet/use-case workflows with a bundled runtime dashboard.

## Fast Context
- Repo map: `.harness/docs/agent/context.md`
- Commands and verification: `.harness/docs/agent/commands.md`
- Module-specific guidance: nearest nested `AGENTS.md`

Read only the smallest relevant context file. Prefer `rg` and targeted file reads. Use caveman or similarly brief output for routine work.

## Hard Rules
- 모든 사용자·agent 출력, commit/PR 메시지, 코드 주석, `docs/` 문서는 한국어로 작성한다. 식별자·경로·명령은 보존한다.
- Use `python3` for Python commands.
- Manage dependencies with the repository-root `venv`.
- Preserve existing ChangeSet, use-case, maintenance, and plan workflow boundaries.
- Do not commit or push ChangeSet-specific workflow artifacts to `origin/main`. This includes `docs/changes/active/**`, `docs/use-cases/**/{e2e-goal.md,use-case.md,event-storming.md,ddd-design.md,technical-decisions.md,class-diagram.md,flow-diagram.md,diagram-metadata.json}`, `docs/plans/active/**`, and `.harness/runs/**`. Keep them on the active ChangeSet branch, PR branch, runtime artifact storage, or generated workspace only.
- Before pushing to `main` or `origin/main`, inspect `git diff --name-only origin/main...HEAD` and stop if it contains ChangeSet-specific workflow artifacts unless the user explicitly asks to publish those artifacts to main.
- When the current runtime payload declares `upstream_context`, inspect high-priority artifacts before acting when their stated purpose applies. These are reading-priority hints, not generic required inputs.
- Do not edit runtime code unless the task explicitly requires it.
- Do not overwrite unrelated worktree changes.
