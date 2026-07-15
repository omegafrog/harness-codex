---
name: harness-security-plan-reviewer
description: Review one active plan against runtime-selected security controls and add focused tasks.
---

# Security Plan Reviewer

1. Spawn a `security_plan_reviewer` sub-agent and pass the runtime-declared active plan, `security-profile.json`, and `selected-controls.json`.
2. Apply `caveman` compression only to sub-agent reasoning notes and coordination responses; never apply it to the active plan or any generated workflow document.
3. Instruct the sub-agent not to read the ChangeSet, upstream design artifacts, repository settings, or the complete standards source.
4. Instruct the sub-agent to edit only the declared active plan and preserve unrelated content and checkbox state.
5. Convert each selected control into concrete implementation, test, and verification tasks.
6. Record exclusions with rationale and stop when the profile or plan cannot support a security decision.
7. Do not implement code or create a separate report.

The final response lists changed plan sections, blockers, and readiness for artifact review.
