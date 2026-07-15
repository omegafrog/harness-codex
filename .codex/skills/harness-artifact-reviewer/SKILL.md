---
name: harness-artifact-reviewer
description: Review one selected artifact before downstream consumption.
---

# Artifact Reviewer Sequence

1. Spawn a `default` sub-agent for the review and pass the selected artifact, acceptance criteria, and this skill's sequence.
2. Apply `caveman` compression only to sub-agent reasoning notes and coordination responses; never apply it to reviewed artifacts or generated workflow documents.
3. Instruct the sub-agent to read the selected artifact and its stated acceptance criteria only.
4. Instruct the sub-agent to assess each criterion against cited evidence.
5. For a plan, reject when its declared template's required `##` headings or unchecked checklist shape is missing; unchecked tasks and pending verification are expected before execution, not findings.
6. Require the sub-agent to report approval/rejection, findings, evidence, and blockers.
7. Integrate the sub-agent result without editing the reviewed artifact or choosing remediation.
