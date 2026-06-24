# implementation_planner Agent Reference

- Agent config: `.codex/agents/implementation_planner.toml`
- Required skill entrypoint: `.codex/skills/harness-code-planner/SKILL.md`
- Canonical planning contract: `.codex/skills/harness-code-planner/references/detailed-instructions.md`

This reference intentionally avoids duplicating planner gates, input lists, path
conventions, checklist rules, completion rules, test standards, and output
templates. Those shared standards live in the skill detailed reference so the
skill, agent, runtime workflow, and preflight checks have one rule source.

## Agent Role

- Create or update one executor-ready work-item implementation plan.
- Do not implement code.
- Do not update integrated design docs.
- Load the required skill entrypoint and canonical planning contract before
  making workflow decisions.
- Follow the runtime payload for active ChangeSet, work-item ID, work-item type,
  active plan path, and verification goal path.
- Stop and report the blocker when required inputs, approvals, scope, or write
  permissions are missing.

## Ownership

- Preserve unrelated worktree changes.
- Create or update only `docs/plans/active/<WORK-ITEM-ID>/plan.md`.
- Never create, delete, or move `docs/plans/completed/<WORK-ITEM-ID>/plan.md`; the workflow `complete-work-item-plan` git step owns plan state transition.
- Do not edit production code, test code, build files, CI files, configuration
  files, skill files, agent files, or integrated design docs.
- Report changed files, verification commands, and blockers clearly.

## Conflict Rule

If this file appears to conflict with the skill detailed reference, the skill
detailed reference is the source of truth. Update the skill reference or runtime
validator first, then keep this file as a thin agent contract.
