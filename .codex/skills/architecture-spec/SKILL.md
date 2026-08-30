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
- `references/topics.md`
- `references/template.md`

## Process

1. Read the Product Spec and guidance first.
2. MUST read `references/topics.md` before starting the architecture interview.
3. Run `code-research` to summarize the current structure and the gap from the target design.
4. Use every topic in `references/topics.md` as the Architecture Spec coverage checklist.
5. Mark descriptive facts as settled when they are supported by the Product Spec, code-research, tests, ADRs, or project documents.
6. Do not treat current implementation choices as automatically settling the target design when multiple valid architectures remain.
7. Run the `grill-with-docs` interview with the architecture coverage checklist.
8. Ask only about material target decisions that remain `PARTIAL` or `UNRESOLVED` after evidence is considered.
9. For DDD design, resolve and confirm the relevant `bounded context`, `aggregate`, `entity/value object/domain service`, state transition, repository boundary, and business-rule ownership decisions. Do not silently choose among material alternatives.
10. Resolve program-design and technical-architecture decisions required by `references/template.md`, including responsibilities, call contracts, interfaces, dependency rules, runtime behavior, failure handling, and integration contracts where applicable.
11. Add class and state diagrams that reflect the settled design. The diagrams must show relationships, responsibilities, state transitions, and transition conditions rather than repeat the tables.
12. Write the Architecture Spec only after the `grill-with-docs` completion gate passes.

## Coverage gate

The Architecture Spec MUST NOT be written while any applicable topic in `references/topics.md` is `PARTIAL` or `UNRESOLVED`.

A target design decision is `SETTLED` only when one of the following is true:

- It is constrained to one valid outcome by the completed Product Spec and authoritative architecture evidence.
- It is already established by an applicable ADR or explicit project constraint.
- The user explicitly confirms the decision.

Code-research may settle facts about the current architecture. It does not by itself settle a future architecture choice merely because the current code already uses one option.

There is no minimum question count. Question count follows unresolved coverage. Zero-question completion is allowed only under the exceptional zero-question rule defined by `grill-with-docs`.

## Connection

- `architecture-spec` owns the architecture coverage checklist, evidence gathering, and document contract.
- `grill-with-docs` owns the interactive question loop and interview completion gate.
- `code-research` settles current-system facts; it does not replace stakeholder confirmation of material target decisions.

## Completion Criteria

- Every applicable topic in `references/topics.md` is settled.
- No material architecture decision is based only on model preference or inference.
- No blocking design decision, contradiction, risk requiring a decision, or open question remains.
- Do not hide mismatches between the code and requirements.
- Do not ask again about facts already settled in the Product Spec or authoritative evidence.
- Do not copy the full code-research transcript into the Architecture Spec.
- Generate `docs/specs/<ticket-id>/architecture-spec.md` in the format of `references/template.md`.
- Include both a class diagram and a state diagram. If a structure does not apply, state `not applicable` and provide the reason.
