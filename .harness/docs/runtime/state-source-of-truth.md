# Runtime State Source of Truth

## Policy

`RunState` stored at `.harness/runs/<run-id>/state.json` is the authoritative workflow state model.

It owns:

- current runtime stage and resume target
- gate status and failure kind
- accepted artifact state
- dirty/downstream reapply state
- deterministic resume decisions

ChangeSet Markdown remains durable user-facing documentation. Its `Runtime Procedure State` table is a mirror of runtime state, not an independent gate authority.

Skill wrapper state may remember conversation-local pause context such as pending questions and approval ownership. It must not independently decide whether a runtime stage is complete when a matching `RunState` exists.

`procedure_stages.py` defines static workflow metadata: stage IDs, display names, agent/skill ownership, inputs, outputs, and verification terms. Runtime status must be derived from `RunState`.

## Reconciliation

Runtime and ChangeSet stage status can drift when users edit Markdown or when old wrapper/session state is resumed. Reconciliation compares the mirrored ChangeSet procedure table against latest `RunState` artifact projection.

When they disagree, runtime behavior must follow `RunState`. UI and CLI projections should surface drift so the table can be repaired without letting stale Markdown unlock or skip gates.

## Resume

`resume` uses `RunState` through `decide_resume_target`. Verified artifacts may inform whether a target can run, but the ChangeSet table alone must not mark a gate complete.
