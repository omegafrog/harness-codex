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
- Read `docs/architecture/constraints.md` when present
- Related ADRs
- `code-research` result
- `references/topics.md`
- `references/template.md`

## Process

1. Read the Product Spec and guidance first.
2. MUST read `references/topics.md` before starting the architecture interview.
3. Run `code-research` to summarize the current structure and the gap from the target design.
4. Use every topic in `references/topics.md` as the Architecture Spec coverage checklist.
5. Mark descriptive facts as settled when they are supported by the Product Spec, code-research, tests, ADRs, user-managed architecture constraints, or project documents.
6. Do not treat current implementation choices as automatically settling the target design when multiple valid architectures remain.
7. Run the `grill-with-docs` interview with the architecture coverage checklist.
8. Ask only about material target decisions that remain `PARTIAL` or `UNRESOLVED` after evidence is considered.
9. For DDD design, classify domain concepts and capabilities before promoting boundaries. Resolve and confirm the relevant `bounded context`, `aggregate`, `entity/value object/domain service`, state transition, repository boundary, and business-rule ownership decisions. Do not silently choose among material alternatives.
10. Resolve program-design and technical-architecture decisions required by `references/template.md`, including responsibilities, call contracts, interfaces, dependency rules, runtime behavior, failure handling, integration contracts, and the weakest sufficient code/runtime boundary where applicable.
11. When applicable, delegate 독립적인 클래스(class) and 설계 상태(design-state) diagrams that reflect the settled design to the lightweight `diagram_creator` agent. Supply the settled design, exact IDs, and ticket scope; the diagrams must show relationships, responsibilities, state transitions, and transition conditions rather than repeat the tables; do not duplicate a Product business-state diagram when the purpose is the same.
12. Write the Architecture Spec only after the `grill-with-docs` completion gate passes.
13. Before declaring completion, promote settled project-wide or context-scoped canonical terms to `CONTEXT.md`; record settled bounded-context names, responsibilities, and relationships in `CONTEXT-MAP.md`. Keep architecture-only temporary wording in the ticket-scoped Spec.

## Boundary Granularity

Boundary creation is promotion, not decomposition.

A domain concept MUST NOT automatically become a bounded context, code module, or independently deployable service. Treat the following as different levels of architectural strength:

```text
Domain concept
→ Entity / Value Object / Domain Service
→ Aggregate
→ Internal capability
→ Bounded Context
→ Code module
→ Deployment service
```

Use the weakest boundary that preserves the required ownership, consistency, dependency isolation, and runtime properties. The default is to keep a capability inside an existing bounded context when that context can own the capability coherently.

Do not promote a concept to a stronger boundary merely because:

- it has a distinct name,
- it has multiple classes,
- it participates in event-storming,
- it contains domain logic,
- it has its own aggregate or domain service,
- it could theoretically expose an API,
- or it may be reusable.

Promote a capability to a new bounded context only when there is material evidence of autonomous domain ownership, such as:

- a distinct ubiquitous language or model whose meaning differs from neighboring contexts,
- independent business rules and invariants,
- independent state or data lifecycle,
- an independent consistency or transaction boundary,
- meaningful change independence,
- or a clear upstream/downstream relationship that requires translation.

Strong signals against creating a separate bounded context include:

- the capability exists primarily to support another context's use cases,
- it has no independently owned state or data lifecycle,
- most calls would be synchronous and occur inside another context's workflow,
- correctness requires frequent cross-boundary transactions,
- it cannot meaningfully operate without the parent context,
- its vocabulary has the same meaning as the parent context,
- or the boundary is primarily around a technical operation, algorithm, or named feature.

Promote a bounded context to a separate code module only when compile-time isolation provides concrete architectural value. Promote a module to an independently deployable service only when independent deployment, scaling, failure isolation, ownership, or operational lifecycle is a plausible requirement.

For every proposed new bounded context, module, or service, explicitly explain why the next weaker boundary is insufficient and what cost the stronger boundary introduces.

When the target system starts as a modular monolith and may evolve toward MSA, preserve explicit context ownership and contracts without pre-creating a service for every capability. Extraction readiness means preserving ownership and seams, not mirroring every domain concept as a deployment boundary.

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
- Every new bounded context, module, or service has passed the boundary-promotion test and documents why a weaker boundary is insufficient.
- No blocking design decision, contradiction, risk requiring a decision, or open question remains.
- Settled vocabulary and bounded-context changes are reflected in `CONTEXT.md` and/or `CONTEXT-MAP.md` according to the durable-vocabulary placement rules.
- Do not hide mismatches between the code and requirements.
- Do not ask again about facts already settled in the Product Spec or authoritative evidence.
- Do not copy the full code-research transcript into the Architecture Spec.
- Generate `docs/specs/<ticket-id>/architecture-spec.md` in the format of `references/template.md`.
- For applicable structure, create independent `.puml` originals and matching SVGs under `docs/specs/<ticket-id>/diagrams/architecture/`; use the class and design-state filename/ID/link rules in `references/template.md`.
- Include a class diagram and/or design-state diagram when applicable. If either structure does not apply, state `해당 없음` and provide the reason. Do not duplicate an equivalent Product business-state diagram.
- Do not complete the Architecture Spec until source, local SVG render, Markdown SVG link, and content-consistency checks pass. A render failure blocks completion.
- `diagram_creator`만 Architecture 다이어그램 원본·렌더 산출물을 작성한다. `architecture-spec`는 설계 결정을 정하고 서브에이전트 산출물을 검토한다.
