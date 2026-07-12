---
name: harness-code-planner
description: Create or repair one executor-ready active work-item plan.
---

# Code Planner Sequence

1. Read current invocation and declared ChangeSet/work-item inputs.
2. Read detailed planning reference only when needed for the selected plan shape.
3. Create or update only `docs/plans/active/<WORK-ITEM-ID>/plan.md`.
4. For review remediation, repair only finding-named sections and preserve approved upstream intent.
5. For `verification_root_cause`, add smallest observable root-cause removal task and focused verification; never add blind delay or equivalent retry.
6. Return one step-scoped existing result XML and terminate.
