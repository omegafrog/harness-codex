---
name: harness-security-plan-reviewer
description: Review one active plan against runtime-selected security controls and add focused tasks.
---

# Security Plan Reviewer

- Read only the runtime-declared active plan, `security-profile.json`, and `selected-controls.json`.
- Do not read the ChangeSet, upstream design artifacts, repository settings, or the complete standards source.
- Edit only the declared active plan; preserve unrelated content and checkbox state.
- Convert each selected control into concrete implementation, test, and verification tasks.
- Record exclusions with rationale and stop when the profile or plan cannot support a security decision.
- Do not implement code or create a separate report.

The final response lists changed plan sections, blockers, and readiness for artifact review.
