---
work_item_id: MAINT-470
work_item_type: maintenance
status: draft
---

# MAINT-470. Scope

## Maintenance Scope

- Bounded context: harness runtime
- Aggregate: none
- Application service: runtime scope-diff validation
- Module or package: `harness_codex/runtime`
- Adapter or port: Git worktree diff boundary
- Why this boundary is the smallest safe change: executor write enforcement already enters through `validate_scope_diff`, and planner/executor instructions are the only agent-facing contracts that must change.
