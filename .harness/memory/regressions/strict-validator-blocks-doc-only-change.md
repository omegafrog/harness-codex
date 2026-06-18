---
id: strict-validator-blocks-doc-only-change
type: regression
scope: harness
status: candidate
confidence: medium
created_at: 2026-06-18
last_validated: 2026-06-18
summary: >
  Overly strict validation may block documentation-only or investigation-only work.
decision_impact: >
  Plan validation must distinguish runtime code, docs-only, refactoring, and investigation scopes before requiring executable runtime commands.
applies_to:
  stages:
    - plan-writing
    - implementation
  work_item_types:
    - maintenance
does_not_apply_to:
  - runtime-code changes that require executable tests
evidence:
  - issue:#359
regression_risks: []
---
# Regression: strict-validator-blocks-doc-only-change

## What Improved

Stricter validation can prevent incomplete plans from reaching implementation.

## What Can Break

Documentation-only or investigation-only maintenance work may not need runtime test commands, but it still needs concrete evidence.

## Lesson

Validators should require executable commands for runtime code changes and allow scoped evidence checks for documentation or investigation work.
