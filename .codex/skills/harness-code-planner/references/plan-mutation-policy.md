# Plan Mutation Policy

Planner repair loops are patch-only.

The initial `plan-work-item` invocation may create a complete executor-ready plan. Any later `plan-work-item`
invocation caused by review rejection, scope conflict, implementation failure, verifier ambiguity, or environment
blocker may only make the smallest targeted patch needed to unblock the next workflow step.

## Allowed Mutation Kinds

- `review_remediation`: edit only the sections directly named by the review blocking finding.
- `verification_command_repair`: clarify runnable commands, expected results, or evidence references under `## 집중 검증` or verification results.
- `scope_boundary_repair`: narrow or correct allowed paths under `## 실행 경계` when runtime scope evidence proves the current boundary is wrong.
- For `scope_boundary_repair`, never broaden executor write scope to include runtime control, policy, agent-context,
  review, verification-tool configuration, or read-only context files. Remove those paths from implementation scope and
  rewrite the plan/affected-files alignment toward product implementation files only: source files, tests, build files,
  and maintained execution scripts.
- `checklist_state_preservation`: preserve, carry forward, or minimally split existing checklist items while keeping completed state.
- `evidence_reference_repair`: fix stale or missing evidence paths without changing implementation direction.

## Forbidden Mutations

- Full plan rewrite.
- Reordering unrelated sections.
- Resetting `- [x]` checklist items to `- [ ]`.
- Replacing a completed implementation direction with a new approach.
- Adding unresolved `BLOCKER-*`, approval, scope-recovery, token-acquisition, or user-decision tasks.
- Editing sections unrelated to the triggering runtime failure.
- Making completion depend on external approval or credentials that the executor cannot obtain inside the declared boundary.

## Runtime Mutation Request

When the runtime restarts planning after a failure, read `.harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/plan-mutation-request.json` before editing `plan.md`.

The request is authoritative for repair scope:

- `mode` must be treated as `patch_only`.
- `trigger_step`, `trigger_failure_kind`, and `trigger_error` describe the only failure to repair.
- `trigger_metadata` may include verifier evidence such as blocked files or scope-diff reports; use it to remove
  out-of-scope paths instead of adding them to the implementation allowlist.
- `allowed_sections` is the only set of plan sections that may change.
- `preserve_checked_checkboxes` forbids removing completed execution state.
- `forbid_full_rewrite` forbids replacing the plan wholesale.
- `forbid_unresolved_blocker_tasks` forbids handing unresolved blockers to the executor.

If the requested repair cannot be completed inside these limits, stop and report a planner blocker. Do not broaden the edit.

When `forbid_scope_broadening` is true, the repair must reduce or correct scope. Do not add files such as `AGENTS.md`,
`.semgrep/**`, `.codex/**`, `.harness/**`, review artifacts, runtime logs, or generated reports to the executor's
affected-files list. Build files and maintained launcher scripts are valid only when they are directly required by the
work item.
