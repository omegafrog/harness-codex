# Plan Mutation Policy

Planner repair loops produce a clean current-run executor input.

The initial `plan-work-item` invocation may create a complete executor-ready plan. Any later `plan-work-item`
invocation caused by review rejection, scope conflict, implementation failure, verifier ambiguity, or environment
blocker must rewrite only what is needed to make `docs/plans/active/<WORK-ITEM-ID>/plan.md` a clean input for the
current run. Remove completed items that need no more work. Convert any item that needs more work into a current-run
unchecked task.

## Allowed Mutation Kinds

- `review_remediation`: edit only the sections directly named by the review blocking finding.
- `verification_command_repair`: clarify runnable commands, expected results, or evidence references under `## 집중 검증` or verification results.
- `scope_boundary_repair`: narrow or correct allowed paths under `## 실행 경계` when runtime scope evidence proves the current boundary is wrong.
- For `scope_boundary_repair`, never broaden executor write scope to include runtime control, policy, agent-context,
  review, verification-tool configuration, or read-only context files. Remove those paths from implementation scope and
  rewrite the plan toward product implementation files only: source files, tests, build files,
  and maintained execution scripts.
- If the trigger is legacy scope-mismatch text from older review evidence, repair only the plan execution boundary when the ChangeSet scope or repository layout proves the current boundary is wrong.
- For non-evolve runs, never add `AGENTS.md`, `**/AGENTS.md`, `.codex/**`, `.semgrep/**`, `.harness/**`, `.harness/docs/**`, `.harness-codex/**`,
  `harness_codex/**`, `tests/runtime/**`, `completions/**`, the root `harness` launcher,
  `scripts/install-harness-codex.sh`, or `scripts/bump_runtime_version.py` to the plan write boundary.
  Treat them as read-only/control-plane evidence and narrow the plan instead.
- `checklist_rewrite`: remove completed no-op checklist items, keep only current-run executor work, and mark modified work `- [ ]`.
- `evidence_reference_repair`: fix stale or missing evidence paths without changing implementation direction.

## Forbidden Mutations

- Full plan rewrite unrelated to the trigger.
- Reordering unrelated sections.
- Carrying stale `- [x]` checklist state forward when the plan is being rewritten for a new current-run execution.
- Leaving prior PASS evidence paths in active-plan verification results.
- Replacing a completed implementation direction with a new approach.
- Adding unresolved `BLOCKER-*`, approval, scope-recovery, token-acquisition, or user-decision tasks.
- Editing sections unrelated to the triggering runtime failure.
- Making completion depend on external approval or credentials that the executor cannot obtain inside the declared boundary.

## Runtime Mutation Request

When the runtime restarts planning after a failure, read `.harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/plan-mutation-request.json` before editing `plan.md`.

The request is authoritative for repair scope:

- `mode` must be treated as `repair`.
- `trigger_step`, `trigger_failure_kind`, and `trigger_error` describe the only failure to repair.
- `trigger_metadata` may include verifier evidence such as blocked files or scope-diff reports; use it to remove
  out-of-scope paths instead of adding them to the implementation allowlist.
- `allowed_sections` is the only set of plan sections that may change.
- `rewrite_checklist_for_current_run` means completed no-op tasks should be removed, and tasks needing current work should be unchecked.
- `forbid_full_rewrite` forbids replacing the plan wholesale.
- `forbid_unresolved_blocker_tasks` forbids handing unresolved blockers to the executor.
- `evolve_allowed` is false for normal project implementation. When false, runtime/agent/skill/workflow/control-plane
  paths must be removed from implementation scope rather than authorized.

If the requested repair cannot be completed inside these limits, stop and report a planner blocker. Do not broaden the edit.

When `forbid_scope_broadening` is true, the repair must reduce or correct scope. Do not add files such as `AGENTS.md`,
`.semgrep/**`, `.codex/**`, `.harness/**`, `.harness/docs/**`, review artifacts, runtime logs, or generated reports to the executor's
execution boundary. Build files and maintained launcher scripts are valid only when they are directly required by the
work item.

Legacy scope-mismatch repair flow:

- Read the blocked file list and scope-diff evidence from `trigger_error` and `trigger_metadata`.
- Remove or mark non-applicable any plan task or execution-boundary entry that caused blocked control/tooling/read-only paths.
- Send the plan back through security/review before execution continues.
