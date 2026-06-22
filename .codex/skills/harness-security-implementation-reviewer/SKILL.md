---
name: harness-security-implementation-reviewer
description: Independently review one implemented ChangeSet work item after product verification and before completion. Inspect the implemented diff, active plan, verification evidence, and applicable OWASP controls. Use this as a blocking delivery gate.
---

# Harness Security Implementation Reviewer

## Scope

- Read only runtime-declared inputs and the repository diff relevant to the active work item.
- Do not edit implementation code, plans, ChangeSet documents, or upstream artifacts.
- Produce exactly one report at the runtime-declared output path.

## Review Flow

1. Derive the implemented attack surface from the active ChangeSet, work-item documents, active plan, verification evidence, and changed files.
2. Review applicable controls against the pinned OWASP sources in `.codex/security/`.
3. Check that security plan tasks are implemented and supported by focused evidence.
4. Write the report headings below.

## Report Contract

The first non-heading status line must be exactly one of:

- `Security Review Status: approved`
- `Security Review Status: rejected`

The report must contain:

- `## Reviewed Inputs`
- `## Security Findings`
- `## Remediation Target`
- `## Evidence`

For an approved review, `## Remediation Target` is `none`. A rejected review blocks delivery and must state whether the owner is `plan` or `implementation`.
