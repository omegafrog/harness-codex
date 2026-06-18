---
id: incomplete-plan-contract
type: failure-pattern
scope: harness
status: active
confidence: high
created_at: 2026-06-18
last_validated: 2026-06-18
summary: >
  Plan-writing can produce a plan.md that exists but lacks executable verification criteria.
decision_impact: >
  Before implementation, validate that plan.md contains concrete verification commands or an explicitly accepted alternative for docs-only or investigation-only work.
applies_to:
  stages:
    - plan-writing
    - implementation
  work_item_types:
    - use-case
    - maintenance
  change_types:
    - runtime-code
    - test-hardening
does_not_apply_to:
  - docs-only work with explicit document validation
  - investigation-only work with accepted evidence output
evidence:
  - issue:#359
known_fixes:
  - add-stage-boundary-validator
  - strengthen-output-contract
regression_risks:
  - strict-validator-blocks-doc-only-change
---
# Failure Pattern: incomplete-plan-contract

## Symptom

`plan-writing` appears to succeed, but `implementation` later blocks because `plan.md` lacks executable verification steps or explicit accepted alternatives.

## Typical Causes

- Planner instructions allow vague checklist items.
- Template checks verify file presence instead of semantic completion.
- Downstream implementation assumes upstream plan artifacts are complete.

## Detection

- `docs/plans/active/<WORK-ITEM-ID>/plan.md` exists.
- Verification criteria are missing, vague, or only reference documents without rationale.
- Implementation stage reports an incomplete plan contract.

## Known Fixes

- Add a stage-boundary validator before implementation.
- Strengthen planner output contract.
- Update plan templates to require executable verification or explicit alternative evidence.

## Regression Risks

Strict validation can block docs-only or investigation-only work unless the validator understands those scopes.
