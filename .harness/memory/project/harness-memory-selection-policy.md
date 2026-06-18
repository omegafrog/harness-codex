---
id: harness-memory-selection-policy
type: project-rule
scope: harness
status: active
confidence: high
created_at: 2026-06-18
last_validated: 2026-06-18
summary: >
  Promote only reusable, evidence-backed, scoped, safe lessons into long-term memory.
decision_impact: >
  Memory candidates must explain how future planning, implementation, verification, or evolution behavior changes before they become active memory.
applies_to:
  stages:
    - requirements-definition
    - use-case-definition
    - event-storming
    - ddd-architecture-definition
    - technical-decisions
    - plan-writing
    - implementation
    - verification
  work_item_types:
    - use-case
    - maintenance
does_not_apply_to:
  - raw traces without evidence summaries
  - secrets or sensitive data
evidence:
  - issue:#360
known_fixes: []
regression_risks: []
---
# Project Rule: harness-memory-selection-policy

## Rule

Store long-term memory only when it is likely to recur, changes future behavior, is expensive to rediscover, is stable enough to reuse, has evidence, has clear scope, and is safe to store.

## Required Active Fields

- `decision_impact`
- `applies_to`
- `evidence`

## Do Not Store

- Raw trace logs as active memory.
- Current run state.
- One-off command output.
- Easily searchable file paths or constants.
- Unvalidated guesses.
- Secrets, tokens, credentials, or personal data.
