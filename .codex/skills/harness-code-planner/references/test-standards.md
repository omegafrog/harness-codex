## Embedded Test Planning Standards

Use these standards when writing the plan. Do not read blog posts at runtime.

- Domain rules must be tested close to the model that owns the rule.
- Aggregate tests verify state transitions, invariants, and rule violations through aggregate behavior methods.
- Value object tests verify constructor-time validation, immutability expectations, and invalid value rejection.
- Domain service tests verify domain calculations or decisions that require multiple domain concepts.
- Application service tests verify orchestration flow: repositories/ports are called, aggregates are loaded and saved, domain methods are invoked, external ports are used through interfaces, and failure paths trigger compensating actions when required.
- Application service tests must not re-test internal aggregate rules as service logic; those belong in aggregate tests.
- Infrastructure tests verify adapters, persistence mappings, serialization, messaging, local storage, framework wiring, and external technology integration.
- Communication tests verify outbox/inbox behavior, idempotency, message identity, aggregate key ordering, retry metadata, and status checks before consuming events when messaging exists.
- Compatibility tests must cover existing use cases that share a modified aggregate, entity, value object, domain service, or port.
- Prefer focused unit tests for domain rules over broad integration tests when no external technology is involved.
- Use integration tests only where persistence, messaging, HTTP clients, framework wiring, or transaction behavior must be verified.
- Test names should describe the business rule or flow outcome.
- Tests should cover success path, important failure path, and boundary conditions.

