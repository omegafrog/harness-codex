---
work_item_id: MAINT-470
work_item_type: maintenance
status: draft
---

# MAINT-470. Architecture impact

## Decision

update

## Impact

The runtime write boundary changes from a mostly path-allowlist model to a category-aware executor policy:

- protected harness control-plane paths are blocked first;
- runtime output paths are allowed separately from implementation files;
- project source/test writes are constrained by the active plan module boundary;
- config/build/script edits require explicit exceptions.

This preserves the existing scope-diff validation entrypoint while making the policy easier for planner and executor agents to understand.
