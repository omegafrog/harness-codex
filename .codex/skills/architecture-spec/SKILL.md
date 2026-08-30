---
name: architecture-spec
description: Turn a completed Product Spec into an implementation-ready architecture contract. Use when defining boundaries, design decisions, and codebase impact before planning.
---

# Architecture Spec

## Purpose

Turn the Product Spec into an implementable architecture contract.

## Inputs

- Completed Product Spec
- `CONTEXT.md`
- Read `CONTEXT-MAP.md` when present
- Related ADRs
- `code-research` result

## Process

1. Read the Product Spec and guidance first.
2. Run `code-research` to summarize the current structure and the gap from the target design.
3. Run the `grill-with-docs` interview to complete `references/template.md`. Divide the DDD architecture into `entity/method`, `service`, `aggregate`, and `bounded context`, then draft and confirm each structure.
4. Add class and state diagrams that reflect the actual design. The diagrams must show relationships, responsibilities, state transitions, and transition conditions rather than repeat the tables.

## Completion Criteria

- Do not complete while unresolved design decisions remain.
- Do not hide mismatches between the code and requirements.
- Do not ask again about facts already settled in the Product Spec.
- Do not copy the full code-research transcript into the Architecture Spec.
- Generate `docs/specs/<ticket-id>/architecture-spec.md` in the format of `references/template.md`.
- Include both a class diagram and a state diagram. If a structure does not apply, state `not applicable` and provide the reason.
