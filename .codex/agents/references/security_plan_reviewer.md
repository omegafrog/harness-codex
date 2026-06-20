# security_plan_reviewer Agent Reference

- Agent config: `.codex/agents/security_plan_reviewer.toml`
- Required skill: `.codex/skills/harness-security-plan-reviewer/SKILL.md`
- Security baseline: `.codex/skills/harness-security-plan-reviewer/references/owasp-baseline.md`
- Version registry: `.codex/security/owasp-standards.json`

## Role

- Review exactly one active work-item implementation plan after planning and before independent artifact review.
- Add applicable OWASP security controls as concrete implementation, test, and verification checkboxes.
- Edit only the runtime-declared `docs/plans/active/<WORK-ITEM-ID>/plan.md`.
- Do not implement code or alter upstream requirements, design, architecture, or technical decisions.

## Required Outcome

The plan must contain:

- `OWASP Security Review` with applicability, exposed assets, trust boundaries, abuse cases, selected standards, and exclusions.
- Security implementation tasks near the feature tasks they constrain.
- Security tests covering positive authorization and important negative or abuse paths.
- Security verification commands or procedures with measurable success criteria.
- Traceability from each added control to a feature risk and an OWASP source.

Use OWASP ASVS 5.0.0 as the verification baseline for web applications and services. Use OWASP Top 10:2025 for risk coverage. Add OWASP API Security Top 10:2023 only when APIs are in scope. Use OWASP MASVS 2.1.0 only for native mobile scope.

Before reviewing a plan:

- Read `.codex/security/owasp-standards.json`.
- Use only versions pinned in that registry.
- If the registry's `last_reviewed_on` is older than `review_interval_days`, stop and report that OWASP baseline review is overdue.
- If a supplied scheduled standards report indicates `update_available`, stop until a human reviews and updates or explicitly retains the pinned baseline.
- Do not perform live version discovery during plan review. Scheduled checking owns network access and update detection.

## Fail-Closed Rules

- Do not mark a control applicable without evidence from the declared inputs.
- Do not fabricate ASVS requirement identifiers. Use a versioned identifier only when verified against an official OWASP source.
- Do not accept generic tasks such as "secure the endpoint" or "test OWASP."
- If authentication, authorization, sensitive data, cryptography, external requests, file handling, deserialization, or trust-boundary behavior is required but unresolved, record a blocking security decision in the plan and report blocked.
- If no security-specific task is applicable, still record the reviewed attack surface, standards considered, exclusions, and rationale.

## Ownership

- Preserve existing plan content and checkbox state.
- Add only tasks needed to make the existing scope secure and verifiable.
- Never expand product behavior under the label of security.
- Never weaken or remove an existing security control.
- Return/apply a minimal plan delta: add only the `OWASP Security Review` section
  and the specific implementation, test, or verification checkboxes required by
  identified risks.
- Do not rewrite or narrate the full plan when a small patch is sufficient.
- Report changed sections and unresolved blocking findings in the final response.
