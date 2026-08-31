# Architecture Spec Interview Topics

Use these topics as the coverage checklist for the architecture interview. The checklist is about unresolved design decisions, not about mechanically asking one question for every section.

1. **Design Scope and Product Mapping**
   Confirm how Product Spec use cases, business rules, invariants, state transitions, and failure cases map into architecture responsibilities.

2. **Domain Flow and Hotspots**
   Resolve commands, events, policies, read models, external interactions, and any domain-flow uncertainty that materially changes the design.

3. **Domain Boundaries and Bounded Context Promotion**
   Classify domain concepts and capabilities before deciding bounded contexts. Resolve which capabilities belong to an existing bounded context, which boundaries are aggregate or internal-capability boundaries only, whether any capability genuinely requires a new bounded context, and why a weaker boundary would be insufficient. Do not equate a domain concept, aggregate, feature, domain service, technical operation, or event-storming cluster with a bounded context.

4. **Context Map and Business Rule Ownership**
   For the bounded contexts that remain after promotion, resolve responsibilities, ownership boundaries, upstream/downstream relationships, translations, integration contracts, aggregate boundaries, aggregate roots, invariants, consistency boundaries, and where each business rule is enforced.

5. **Entities, Value Objects, and Domain Services**
   Resolve identities, state ownership, value semantics, validations, domain behaviors, and domain-service responsibilities when they materially affect implementation.

6. **State Transitions and Repository Boundaries**
   Resolve allowed state transitions, guards, emitted events, persistence ownership, repository operations, and consistency boundaries.

7. **Program Design**
   Resolve major components, responsibilities, application flow, call contracts, major types, interfaces, function signatures, error propagation, and dependency rules.

8. **Technical Architecture and Boundary Mapping**
   Map domain boundaries to code and runtime boundaries without assuming one-to-one mapping. Explicitly distinguish bounded contexts, internal capabilities, code modules, and deployment services. Prefer the weakest boundary that preserves the required isolation. For every new module or service boundary, resolve why the weaker boundary is insufficient, what dependency or ownership problem the boundary solves, what coupling or operational cost it introduces, and whether independent deployment, scaling, failure isolation, ownership, or operational lifecycle is a plausible requirement. Also resolve synchronous and asynchronous communication, API/message contracts, data ownership, schema changes, consistency model, infrastructure dependencies, external dependency isolation, and target file/module structure.

9. **Runtime Design**
   Resolve concurrency, ordering, transaction boundaries, idempotency, duplicate handling, and partial-failure behavior.

10. **Error Handling and Recovery**
    Resolve error classification, retry policy, compensation, recovery, and rollback behavior.

11. **Security and Observability**
    Resolve authentication/authorization impact, input validation, sensitive data handling, secrets, logs, metrics, tracing, and alerts when relevant to the change.

12. **Change and Verification Boundaries**
    Resolve allowed, forbidden, and conditional changes plus the verification evidence required for domain, program, technical, runtime, recovery, and boundary-promotion contracts.

13. **Alternatives, Trade-offs, Risks, and Open Questions**
    Resolve material alternatives, expensive-to-reverse decisions, risks, and every blocking open question. Include the trade-off between the chosen boundary strength and the next weaker viable boundary for every newly introduced bounded context, module, or service.

## Boundary evidence rule

Boundary creation is promotion, not decomposition. A named capability is not evidence by itself that a new bounded context, module, or service is required.

The default is to place a capability inside an existing bounded context when its language, business rules, state/data lifecycle, consistency requirements, and change pattern fit that context.

Strong evidence for promotion may include:

- a distinct ubiquitous language or model,
- independent business rules or invariants,
- independent state or data lifecycle,
- independent consistency or transaction boundaries,
- meaningful change independence,
- required model translation across an upstream/downstream relationship,
- or, for deployment boundaries, a plausible need for independent deployment, scaling, failure isolation, ownership, or operational lifecycle.

Strong evidence against promotion includes:

- the capability primarily supports another context's workflow,
- it has no independent state or data lifecycle,
- most interactions would be synchronous inside a parent workflow,
- correctness requires frequent cross-boundary transactions,
- it shares the same vocabulary and model meaning as the parent context,
- or the proposed boundary is mainly around an algorithm, technical operation, or named feature.

For every proposed stronger boundary, explain why the next weaker boundary is insufficient.

## Evidence rule

Current code, tests, Product Spec, ADRs, and project documents may settle descriptive facts about the existing system. They do not by themselves settle a target architecture decision when multiple valid futures remain.

Ask the user only when a material target decision, trade-off, product interpretation, irreversible architecture choice, or unresolved boundary-promotion decision remains unresolved after the available evidence is read.
