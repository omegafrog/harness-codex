---
work_item_id: MAINT-470
work_item_type: maintenance
status: draft
---

# MAINT-470. Maintenance spec

## Required behavior

The scope-diff validator must classify each executor-created change by ownership category before deciding allow/block:

- runtime artifact;
- protected harness control-plane;
- application source;
- test file;
- build/config/script file;
- other explicitly scoped path.

## Boundary source

The primary boundary is the active plan `implementationBoundary` block. Legacy ChangeSet or plan allowed paths remain a compatibility fallback only when the active plan has no `implementationBoundary` block.

## Scope expansion behavior

When an executor needs to edit outside the declared boundary, it must stop and report a scope expansion request instead of silently editing outside scope.
