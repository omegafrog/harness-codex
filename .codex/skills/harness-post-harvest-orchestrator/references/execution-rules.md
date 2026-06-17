## Execution Rules

- Announce each specialist skill before invoking it.
- Do not perform a specialist skill's work directly from this orchestrator.
- If a specialist skill says to delegate to its configured agent, let that skill perform the delegation.
- During `$harness-ddd-design`, respect its staged approval gates. Do not continue to the
  next DDD stage, technical decisions, planner, or executor until the user explicitly approves
  the current DDD stage and all required DDD outputs exist.
- Do not read `ticketon-ddd블로그` at runtime.
- Do not skip stages unless the user explicitly asks to resume from an existing gate and the gate artifact exists.
- Do not overwrite or delete existing design artifacts unless the invoked specialist skill owns that file and updates it.
- Preserve user changes. If unexpected user edits affect a gate, work with them rather than reverting.
- Do not run `$harness-code-planner` until the active ChangeSet exists, affected UCs are identified,
  every targeted UC E2E goal exists and is approved, implementation-blocking technical decisions are
  resolved, and the user has explicitly approved planning.
- Do not run `$harness-plan-executor` for a UC until `docs/plans/active/<UC-ID>/plan.md` exists and
  references the active ChangeSet and approved UC E2E goal.
- Do not run `$harness-project-wiki` until every affected work-item plan is completed and verified.
- Do not complete `docs/changes/active/<CHG-ID>.md` until every affected UC plan is completed and
  the MkDocs wiki has been created or updated and its strict build passes.
- Do not create the target-repository PR until the ChangeSet completion gate succeeds.
- Do not report completion unless the PR creation gate records a PR URL.
