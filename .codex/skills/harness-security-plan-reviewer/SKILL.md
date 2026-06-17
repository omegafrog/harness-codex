---
name: harness-security-plan-reviewer
description: Review one active ChangeSet work-item implementation plan against applicable OWASP standards and add missing security implementation, test, and verification tasks before executor use. Use after harness-code-planner creates or updates an active work-item plan and before artifact review or implementation execution.
---

# Harness Security Plan Reviewer

## Hot Path

- Read `.codex/agents/references/security_plan_reviewer.md`.
- Read `references/owasp-baseline.md`.
- Read `.codex/security/owasp-standards.json` and use its pinned versions.
- Read only inputs declared by the runtime payload.
- Edit only the declared active work-item `plan.md`.
- Preserve existing content and checkbox state.
- Add risk-specific, testable security tasks. Do not add generic security boilerplate.
- Do not implement code or change upstream artifacts.
- Report blockers when security-relevant decisions are unresolved.

## Review Flow

1. Identify attack surface from feature scope, data, actors, trust boundaries, protocols, dependencies, and deployment shape.
2. Select applicable standards:
   - OWASP ASVS 5.0.0 for web applications and services.
   - OWASP Top 10:2025 for risk coverage.
   - OWASP API Security Top 10:2023 for API scope.
   - OWASP MASVS 2.1.0 for native mobile scope.
3. Map each applicable risk to an implementation control, focused test, verification procedure, and success criterion.
4. Add an `OWASP Security Review` section to the plan.
5. Add checkboxes near relevant implementation, test, and verification sections.
6. Record excluded standards or controls with rationale.
7. Stop when a security-critical decision cannot be derived from approved inputs.

## Task Quality

- Name protected asset and threat.
- Name enforcement layer and expected behavior.
- Include success, denied, malformed, boundary, and replay or idempotency cases when applicable.
- Prefer existing repository security tools and commands.
- When tooling is absent, add a scoped setup task only when required by the identified risk.
- Treat SAST, dependency scanning, secret scanning, and DAST as evidence sources, not substitutes for behavior tests.

## Output Contract

Add or update:

- Security applicability and attack-surface summary.
- OWASP source and version mapping.
- Security implementation checkboxes.
- Security test checkboxes.
- Security verification checkboxes and success criteria.
- Security assumptions, exclusions, and unresolved blockers.

Do not create a separate report. The updated active plan is the workflow artifact consumed by the independent artifact reviewer.
