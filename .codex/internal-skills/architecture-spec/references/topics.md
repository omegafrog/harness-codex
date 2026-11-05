# Architecture Spec Interview Topics

Use these topics as the coverage checklist for the architecture interview. The checklist is about unresolved design decisions, not about mechanically asking one question for every section.

1. **Design Scope and Product Mapping**
   Confirm how Product Spec use cases, business rules, invariants, state transitions, and failure cases map into architecture responsibilities.

2. **Domain Models and Flow**
   Resolve Entities, Value Objects, identity, state, domain methods, business rules, domain services, commands, events, and external interactions. Integrate resolved questions into their models and decisions; retain only unresolved hotspots.

3. **Aggregates**
   Assign the target domain's Entities and Value Objects to Aggregates. Identify each root Entity, members, methods, invariants, consistency and persistence boundaries, and references. A single Entity can be an Aggregate. Distinguish absent current implementation from an accepted target.

4. **Application Services and Bounded Contexts**
   Describe how application services coordinate Aggregate methods, repositories, external effects, transactions and failures using ordered flows. Compare combined and separate Context candidates by their languages, models, rule ownership, data lifecycles, consistency, change independence and translation needs. Document selected boundaries and trade-offs separately from deployment decisions. Connect changed rules to domain methods and forbidden bypasses without a redundant ownership table.

5. **Entities, Value Objects, and Domain Services**
   Resolve identities, state ownership, value semantics, validations, domain behaviors, and domain-service responsibilities when they materially affect implementation.
   Reconcile affected glossary definitions with the settled model. Detect implied definition changes, renames, splits/merges and retirement without an explicit naming request; preserve terms when meanings still fit. Material semantic ambiguities remain unresolved, and settled changes must reach the consumer glossary and downstream references.

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

12. **Quantitative Targets and Technology Basis**
    Establish applicable performance and capacity targets with metric, unit, representative workload, provenance, confidence, and acceptance boundary. Review existing ADRs, approved project constraints, technical-team standards, formal standards, official/primary technical documentation, and valid project measurements. Compare viable options against those targets and standards; preserve source IDs or exact URLs and locators with each option rationale. Record the accepted option, rejected alternatives, trade-offs, and user/owner agreement in the Architecture Decision and Architecture Spec. Record unresolved targets with their owner and resolution method.

13. **Change and Verification Boundaries**
    Resolve allowed, forbidden, and conditional changes plus the verification evidence required for domain, program, technical, runtime, recovery, and boundary-promotion contracts.
    Preserve requirement/rule/target/decision IDs into each slice's domain owner, business-rule unit-test intent and verification command. Unit-test intent specifies the owned rule, meaningful condition/action, and expected business result; exclude generic type/format failures and framework wiring. Trace Product persistence, query and external-capability requirements into selected/existing technology and infrastructure. For each material technology choice, link requirement/target → decision criteria → source-located evidence → options/trade-offs → selected choice → owner/path → verification. For relevant performance goals, define representative workload, units, pre-change baseline capture, comparison conditions and acceptable regression. For each changed communication edge and deployment unit, record evidence, rejected alternatives, failure/consistency semantics and observable extraction trigger.

14. **Alternatives, Trade-offs, Risks, and Open Questions**
    Resolve material alternatives, expensive-to-reverse decisions, risks, and every blocking open question. Compare Context candidates on their domain evidence and trade-offs; separately compare viable code and deployment boundaries.

## Evidence rule

Current code, tests, Product Spec, ADRs, and project documents may settle descriptive facts about the existing system. They do not by themselves settle a target architecture decision when multiple valid futures remain.

Use the [grilling](../../../../.codex/internal-skills/grilling/GUIDE.md) question criteria to distinguish stakeholder decisions from implementation details. Record the engineering rationale without inventing a user statement.
