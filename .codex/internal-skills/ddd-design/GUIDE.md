<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차: [event-storming](../event-storming/GUIDE.md).

# ddd-design

## What it does

`ddd-design` narrows `event-storming` output into aggregates, domain capabilities, bounded-context candidates, consistency, transaction, and integration decisions.

It does not choose packages, modules, persistence, or framework wiring; those choices belong to `codebase-design`.

## Inputs

- Product Spec: 전달된 경로를 사용하며, spec-me 기본 경로는 `docs/specs/<plan-set-id>/product-spec.md`다
- `CONTEXT.md`
- related ADRs
- event-storming output
- Existing affected models, source references, and accepted changes from `CONTEXT-MAP.md` and `docs/architecture/domain-model.md` when present.

Before proposing boundaries, read [model-continuity.md](references/model-continuity.md). It defines existing-model discovery, rule encapsulation, communication/deployment evidence, and the durable model lifecycle. Apply it to affected concepts only; an existing method or function may be the entire design delta.

## Boundary rule

Aggregate boundaries, domain-service boundaries, feature boundaries, and event-storming clusters do not imply bounded-context boundaries.

Compare existing and candidate bounded contexts using their language, model, business rules, data ownership and lifecycle, consistency, change independence, and translation needs. In a new project compare plausible combined and separate contexts fairly; in an existing project evaluate compatibility with established models. Record evidence and trade-offs for the selected boundary. Do not infer it from a feature name, framework, aggregate, code module, or deployment unit alone. Context and deployment decisions are distinct.

For each target domain, define at least one Aggregate and identify Entities and Value Objects and their Aggregate membership. Each Aggregate has a root Entity that protects invariants through domain methods; a single root Entity can form an Aggregate. Record identity, constituent models, operations, invariants, consistency, persistence, and references to other Aggregates. Preserve existing implementation facts even when the accepted target requires a new Aggregate.

## Process

1. Read the Product Spec and domain guidance.
2. Review the event-storming result: actors, commands, events, policies, and external systems.
3. Identify domain Entities, Value Objects, behavior and rules, and group them into Aggregates with root Entities.
4. Describe application services that coordinate Aggregate methods, repositories, external effects and transaction boundaries without owning domain decisions.
5. Compare candidate bounded contexts by meaning, model, business rules, data ownership and lifecycle, consistency, change independence, and translation needs; record the reasons for the chosen boundaries.
6. Do not infer a bounded context from an aggregate, domain service, event-storming cluster, technical subsystem, algorithm, or named feature alone.
7. Decide consistency, transaction, and integration boundaries only as far as the design needs them.
8. Explain the advantages and trade-offs of the selected Context boundaries against plausible alternatives.
9. Ask one question at a time if a stakeholder perspective or material boundary decision is still missing.
10. Hand off structure-level decisions to `codebase-design` without assuming a one-to-one mapping between bounded contexts, code modules, and deployment services.

## Connection

- `event-storming` exposes the business flow and domain shape.
- `ddd-design` identifies domain models and Aggregates, application coordination, and then compares bounded-context candidates.
- `codebase-design` turns the settled DDD shape into package, module, and seam decisions using the weakest sufficient code boundary.

## Output shape

- Domain functions and responsibilities are associated with the chosen Context or an external system.
- Aggregate boundaries are described through entity identity relationships.
- Aggregate boundaries MUST NOT imply bounded-context boundaries.
- Domain behavior is expressed as domain methods or domain services.
- Policies remain design facts that later become unit-testable behavior.
- Each chosen bounded-context boundary includes evidence and trade-offs against plausible alternatives.

## Completion

- The design is concrete enough to implement.
- The established vocabulary is not destabilized.
- Bounded-context candidates are supported by ownership and lifecycle evidence rather than feature naming or implementation structure alone.
- Remaining structural questions are deferred to `codebase-design`.
