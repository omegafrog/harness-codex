# Architecture Spec Interview Topics

Use these topics as the coverage checklist for the architecture interview. The checklist is about unresolved design decisions, not about mechanically asking one question for every section.

1. **Design Scope and Product Mapping**
   Confirm how Product Spec use cases, business rules, invariants, state transitions, and failure cases map into architecture responsibilities.

2. **Domain Flow and Hotspots**
   Resolve commands, events, policies, read models, external interactions, and any domain-flow uncertainty that materially changes the design.

3. **Bounded Contexts and Context Map**
   Resolve context responsibilities, ownership boundaries, upstream/downstream relationships, translations, and integration contracts.

4. **Aggregates and Business Rule Ownership**
   Resolve aggregate boundaries, aggregate roots, invariants, consistency boundaries, and where each business rule is enforced.

5. **Entities, Value Objects, and Domain Services**
   Resolve identities, state ownership, value semantics, validations, domain behaviors, and domain-service responsibilities when they materially affect implementation.

6. **State Transitions and Repository Boundaries**
   Resolve allowed state transitions, guards, emitted events, persistence ownership, repository operations, and consistency boundaries.

7. **Program Design**
   Resolve major components, responsibilities, application flow, call contracts, major types, interfaces, function signatures, error propagation, and dependency rules.

8. **Technical Architecture and Contracts**
   Resolve service/module boundaries, synchronous and asynchronous communication, API/message contracts, data ownership, schema changes, consistency model, infrastructure dependencies, external dependency isolation, and target file/module structure.

9. **Runtime Design**
   Resolve concurrency, ordering, transaction boundaries, idempotency, duplicate handling, and partial-failure behavior.

10. **Error Handling and Recovery**
    Resolve error classification, retry policy, compensation, recovery, and rollback behavior.

11. **Security and Observability**
    Resolve authentication/authorization impact, input validation, sensitive data handling, secrets, logs, metrics, tracing, and alerts when relevant to the change.

12. **Change and Verification Boundaries**
    Resolve allowed, forbidden, and conditional changes plus the verification evidence required for domain, program, technical, runtime, and recovery contracts.

13. **Alternatives, Trade-offs, Risks, and Open Questions**
    Resolve material alternatives, expensive-to-reverse decisions, risks, and every blocking open question.

## Evidence rule

Current code, tests, Product Spec, ADRs, and project documents may settle descriptive facts about the existing system. They do not by themselves settle a target architecture decision when multiple valid futures remain.

Ask the user only when a material target decision, trade-off, product interpretation, or irreversible architecture choice remains unresolved after the available evidence is read.
