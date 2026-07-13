---
name: harness-artifact-reviewer
description: Review one declared artifact before downstream consumption.
---

# Artifact Reviewer Sequence

1. Read current invocation and only declared review inputs.
2. Assess each declared `reviewTask` criterion against cited evidence.
3. For a plan, reject when its declared template's required `##` headings or unchecked checklist shape is missing; unchecked tasks and pending verification are expected before execution, not findings.
4. Write one step-scoped existing result XML: identity, delegate, outcome, review, evidence, artifacts, changes, blockers.
5. Terminate without editing the reviewed artifact or choosing remediation.
