## Invocation

Dedicated agent:

- agent id: `implementation_planner`
- config: `.codex/agents/implementation_planner.toml`
- output file:
  - `docs/plans/active/<WORK-ITEM-ID>/plan.md`
- completion move:
  - from `docs/plans/active/<WORK-ITEM-ID>/plan.md`
  - to `docs/plans/completed/<WORK-ITEM-ID>/plan.md`

Execution rules:

- If the dedicated agent cannot be found or executed, do not perform the agent's work in this skill. Explain the blocker and stop.
- The dedicated agent must not edit production code, test code, build files, CI files, configuration files, skill files, or agent files.
- The dedicated agent's write scope is limited to:
  - `docs/plans/active/<WORK-ITEM-ID>/plan.md`
  - `docs/plans/completed/<WORK-ITEM-ID>/plan.md` only when moving a fully completed and verified plan
- The planner must not update integrated design docs. That belongs to docs-sync after the work item is implemented and verified.
- The planner must not read blog markdown files as planning standards. Test planning standards are embedded in the agent instruction and this skill.

