---
work_item_id: MAINT-470
work_item_type: maintenance
status: draft
---

# MAINT-470. Change intent

## Intent

Replace the executor's broad file-scope authority model with a simpler write policy:

- harness control-plane files are protected from normal executor writes;
- application source writes must stay inside the active plan `implementationBoundary.source`;
- tests must stay inside `implementationBoundary.tests`;
- build/config/script writes require exact `implementationBoundary.configExceptions`;
- runtime artifacts are allowed only under runtime-owned output paths.

## Non-goals

- Do not reintroduce readFrontier/diffContract evidence contracts.
- Do not add new per-step handoff artifacts.
- Do not allow executor edits to harness agent, skill, workflow, or runtime policy files during normal project implementation.
