# DDD Implementation Policy

This is the fixed control-plane policy for `implementation_executor`.

The active `plan.md` remains the sole task-specific product and implementation instruction. This policy supplies stable constraints only. When the plan conflicts with this policy, stop and report a blocker; do not silently choose a new architecture.

## 1. Layer Roles and Dependency Direction

- `domain` contains Aggregate Roots, Entities, Value Objects, Domain Services, Domain Events, Domain Exceptions, Domain Policies, and Aggregate Repository Ports.
- `application` contains use-case/application services, commands, queries, results, transaction boundaries, authorization/idempotency orchestration, and use-case-owned external Ports.
- `ui` contains inbound adapters only: controllers, request/response DTOs, inbound mappers, message consumers, and CLI handlers. It does not contain repository Ports or persistence models.
- `infra` contains repository/cache/message/file-storage/external-API implementations, persistence mappers, and technology- or vendor-specific components.
- `bootstrap` or configuration is the only composition location that may wire all layers.

Default dependency direction:

```text
ui -> application -> domain
infra -> application or domain
bootstrap -> ui, application, domain, infra
```

- `domain` must not depend on `application`, `ui`, `infra`, Spring, JPA, HTTP, JSON, Redis, Kafka, a database driver, or an external SDK.
- `application` must not depend on `ui` or `infra` implementations.
- `ui` must not call `infra` implementations directly.
- `infra` implements Ports owned by `domain` or `application`; it does not own domain policy.

## 2. Aggregate and Domain Model Rules

- Define one Aggregate for each strong transactional consistency boundary.
- Only an Aggregate Root may expose state-changing behavior for its Aggregate.
- Repositories are Aggregate-Root repositories. Do not create repositories for internal Entities.
- Reference another Aggregate by its identifier, not by an object graph.
- Do not mutate another Aggregate directly from an Aggregate.
- Place state transitions, calculations, invariants, and domain policy in the Domain Model.
- Generate Domain Events in the Aggregate when a domain fact occurs.

### Entity and Value Object Construction

- Prefer named static factory methods for public creation paths.
- Validate nullability, format, range, and cross-field invariants at creation and state transition boundaries.
- Do not use public setters for domain state changes; expose intention-revealing domain methods.
- Value Objects are immutable and value-equal.
- Keep persistence restoration constructors non-public or otherwise restricted. Do not bypass validation in a normal creation path.
- Domain models do not accept or return HTTP DTOs, persistence DTOs, or vendor SDK types.

## 3. Application Service and Domain Service

Application Services orchestrate one use case. They may:

- authorize the actor;
- load Aggregate Roots through Ports;
- invoke Aggregate and Domain Service behavior;
- save Aggregate Roots;
- coordinate idempotency, transaction, and external-Port ordering;
- assemble use-case Results.

Application Services must not:

- implement domain state transitions, calculations, or invariants;
- mutate Entity fields through setters;
- use controller DTOs or persistence models as domain objects;
- embed technology-specific client code.

Use a Domain Service only when a stateless domain policy spans multiple Aggregates or has no natural Aggregate owner. A Domain Service must not perform persistence or external I/O itself.

## 4. Ports, Adapters, and Cross-Boundary Collaboration

- Put Aggregate Repository Ports in `domain`.
- Put external Ports in `application` when the use case owns the integration; put them in `domain` only when the Port expresses a domain concept.
- Implement all Ports in `infra`.
- Adapt HTTP/gRPC clients, message producers/consumers, cache clients, storage clients, and database clients in `infra`.
- Never import another module's Entity or call another module's repository implementation directly.

For another Aggregate or Bounded Context, use the mechanism named by the active plan and approved technical decision:

- modular monolith: application Port with internal adapter or a bounded repository query;
- synchronous service boundary: application Port with REST/gRPC adapter;
- asynchronous boundary: Domain Event plus publisher/consumer adapters;
- eventual consistency: event-driven follow-up handling.

## 5. Transactions, Events, and Concurrency

- The default transaction boundary is a public Application Service command method.
- A command should normally change one Aggregate.
- Reconsider Aggregate boundaries before creating one large transaction across several Aggregates.
- Publish externally observable events after transaction commit.
- When reliable external publication is required, follow the active plan's Outbox decision.
- The plan must name optimistic locking, idempotency keys, retries, deduplication, or ordering rules when the use case has concurrency or delivery risk.

## 6. Validation, Errors, DTOs, and Mapping

- `ui` validates request shape and maps request/response DTOs.
- `application` validates authorization, command eligibility, and idempotency.
- `domain` validates business invariants and throws Domain Exceptions.
- Convert infra-specific failures at adapter/application boundaries; do not leak them into domain behavior.
- Do not return Domain Entities or persistence entities directly from `ui`.
- Map UI DTOs to application Commands/Results at the UI/Application boundary.
- Map persistence models to Domain Models inside Infra adapters.

## 7. Tests and Architecture Checks

- Domain tests verify invariants, state transitions, and calculations without framework bootstrapping.
- Application tests verify orchestration with fake/mock Ports.
- Infra integration tests verify adapter behavior against the relevant technology or test double.
- UI tests verify request validation, authorization, status mapping, and response DTOs.
- Add architecture tests when the active plan changes package or dependency boundaries:
  - domain does not depend on application/ui/infra;
  - application does not depend on ui/infra;
  - ui does not depend directly on infra implementations.

## 8. Required Plan Handoff

Before code changes, the active plan must name:

- target bounded context, module, Aggregate Root, and allowed/forbidden paths;
- exact package and responsibility for every created or moved class;
- permitted and forbidden dependency directions/imports;
- invariants, state transitions, Value Object rules, Domain Events, persistence compatibility, and external collaboration decisions;
- allowed cross-scope reads with exact path/pattern and reason;
- transaction, event publication, idempotency, and concurrency choices when applicable;
- focused commands, expected results, and explicit stop conditions.

When any required decision is missing, contradictory, or only expressed as a placeholder, report a blocker. Do not inspect upstream design documents to reconstruct it.
