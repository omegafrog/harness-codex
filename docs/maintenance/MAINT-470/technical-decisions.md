---
work_item_id: MAINT-470
work_item_type: maintenance
status: draft
---

# MAINT-470. Technical decisions

## Decision 1: Use active plan implementationBoundary

Use the active plan as the source of executor write boundaries instead of introducing a new per-step artifact.

## Decision 2: Keep legacy fallback

When an active plan has no `implementationBoundary`, keep the existing ChangeSet / execution scope / support manifest fallback to avoid breaking older active plans immediately.

## Decision 3: Config/build/script explicit exception

When `implementationBoundary` is present, build/config/script files are not allowed by the support manifest. They require `implementationBoundary.configExceptions`.
