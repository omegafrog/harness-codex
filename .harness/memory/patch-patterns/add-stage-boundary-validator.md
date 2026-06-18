---
id: add-stage-boundary-validator
type: patch-pattern
scope: harness
status: active
confidence: high
created_at: 2026-06-18
last_validated: 2026-06-18
summary: >
  Add explicit validation before downstream stages consume generated artifacts.
decision_impact: >
  When a downstream stage fails because an upstream artifact exists but is incomplete, add an explicit artifact contract and validate it at the boundary before continuing.
applies_to:
  stages:
    - plan-writing
    - implementation
    - verification
  work_item_types:
    - use-case
    - maintenance
does_not_apply_to:
  - raw log archival
  - hidden LLM-only memory
evidence:
  - issue:#359
known_fixes:
  - define-artifact-contract
  - add-contract-validator
regression_risks:
  - strict-validator-blocks-doc-only-change
---
# Patch Pattern: add-stage-boundary-validator

## Use When

A downstream stage fails because an upstream artifact exists but is incomplete, stale, or too vague to execute.

## Patch Shape

1. Define explicit required fields or sections for the artifact.
2. Add a validator at the stage boundary.
3. Block downstream execution with an actionable error.
4. Add tests for valid artifacts, invalid artifacts, and scoped exceptions.

## Verification

Run focused validator tests and one downstream-flow test that proves invalid artifacts stop before execution.
