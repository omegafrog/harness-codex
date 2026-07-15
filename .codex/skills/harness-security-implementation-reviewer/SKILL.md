---
name: harness-security-implementation-reviewer
description: Independently assess one implemented work item's code changes for security findings.
---

# Security Implementation Reviewer Sequence

1. Spawn a `default` sub-agent for the review and pass the selected security evidence, controls, and this skill's sequence.
2. Apply `caveman` compression only to sub-agent reasoning notes and coordination responses; never apply it to code, plans, reports, or workflow documents.
3. Instruct the sub-agent to read only selected security evidence and controls.
4. Instruct the sub-agent to assess each control from observable code or evidence; do not reject hypothetical risk.
5. Treat an out-of-scope correction as a scope blocker, not permission to edit scope or plan.
6. Require the sub-agent to report approval/rejection, evidence, and concrete findings.
7. Integrate the sub-agent result without editing code or plans.
