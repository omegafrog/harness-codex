---
name: harness-code-planner
description: Create or repair one executor-ready active work-item plan.
---

# Code Planner Sequence

1. Read the selected ChangeSet, work-item slice, and current active plan when it exists.
2. Read detailed planning reference only when needed for the selected plan shape.
3. Copy the declared plan template's exact `##` headings and unchecked checklist shape into `docs/plans/active/<WORK-ITEM-ID>/plan.md`.
4. For review remediation, repair only finding-named sections and preserve approved upstream intent.
5. For `verification_root_cause`, add smallest observable root-cause removal task and focused verification; never add blind delay or equivalent retry.
6. Report the changed plan, focused verification, and blockers, then terminate.
