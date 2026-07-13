---
name: harness-artifact-reviewer
description: Review one selected artifact before downstream consumption.
---

# Artifact Reviewer Sequence

1. Read the selected artifact and its stated acceptance criteria only.
2. Assess each criterion against cited evidence.
3. For a plan, reject when its declared template's required `##` headings or unchecked checklist shape is missing; unchecked tasks and pending verification are expected before execution, not findings.
4. Report approval/rejection, findings, evidence, and blockers.
5. Terminate without editing the reviewed artifact or choosing remediation.
