---
name: ddd-design
description: Derive aggregate, consistency, transaction, and integration boundaries from event-storming output. Use when shaping domain-driven design before code structure decisions.
---

# ddd-design

## What it does

`ddd-design` narrows `/event-storming` output into aggregates, domain capabilities, bounded-context candidates, consistency, transaction, and integration decisions.

It does not choose packages, modules, persistence, or framework wiring; those choices belong to `codebase-design`.

## Inputs

- Product Spec
- `CONTEXT.md`
- related ADRs
- event-storming output

## Boundary rule

Aggregate boundaries, domain-service boundaries, feature boundaries, and event-storming clusters do not imply bounded-context boundaries.

Treat creation of a new bounded context as a promotion decision. Prefer assigning a capability to an existing bounded context when the language, business-rule ownership, state/data lifecycle, consistency requirements, and change pattern fit that context.

A capability should become a new bounded-context candidate only when there is material evidence that the existing context cannot own it coherently. Evidence may include a distinct ubiquitous language or model, independent business rules or invariants, independent state/data lifecycle, a separate consistency boundary, meaningful change independence, or a required upstream/downstream translation boundary.

Do not create a bounded-context candidate merely because a capability has a distinct name, contains domain logic, owns an aggregate, could expose an API, may be reusable, or is implemented by a technical algorithm.

For every proposed bounded-context candidate, document why modeling it as an internal capability of an existing context would be incorrect or materially harmful.

## Process

1. Read the Product Spec and domain guidance.
2. Review the event-storming result: actors, commands, events, policies, and external systems.
3. Group the flow into aggregate candidates and domain-capability candidates.
4. Assign each capability to an existing bounded context whenever its language, business rules, lifecycle, and consistency requirements fit that context.
5. Treat a new bounded context as an exceptional promotion decision and compare semantic/model independence, business-rule ownership, data/state ownership, consistency and transaction boundaries, change independence, and translation needs before proposing one.
6. Do not infer a bounded context from an aggregate, domain service, event-storming cluster, technical subsystem, algorithm, or named feature alone.
7. Decide consistency, transaction, and integration boundaries only as far as the design needs them.
8. For every proposed bounded context, record why an internal capability boundary in an existing context is insufficient.
9. Ask one question at a time if a stakeholder perspective or material boundary decision is still missing.
10. Hand off structure-level decisions to `codebase-design` without assuming a one-to-one mapping between bounded contexts, code modules, and deployment services.

## Connection

- `event-storming` exposes the business flow and domain shape.
- `ddd-design` classifies aggregates and capabilities, then promotes only sufficiently independent capabilities into bounded-context candidates.
- `codebase-design` turns the settled DDD shape into package, module, and seam decisions using the weakest sufficient code boundary.

## Output shape

- Domain capabilities are classified as part of an existing bounded context, a justified new bounded-context candidate, or an external system.
- Aggregate boundaries are described through entity identity relationships.
- Aggregate boundaries MUST NOT imply bounded-context boundaries.
- Domain behavior is expressed as domain methods or domain services.
- Policies remain design facts that later become unit-testable behavior.
- Every new bounded-context candidate includes the evidence for promotion and why the weaker internal-capability boundary is insufficient.

## Completion

- The design is concrete enough to implement.
- The established vocabulary is not destabilized.
- Bounded-context candidates are supported by ownership and lifecycle evidence rather than feature naming or implementation structure alone.
- Remaining structural questions are deferred to `codebase-design`.
