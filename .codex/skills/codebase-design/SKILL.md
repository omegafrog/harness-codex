---
name: codebase-design
description: Translate DDD decisions into concrete packages, seams, adapters, files, and tests. Use after architecture design and before implementation planning.
---

# codebase-design

## What it does

`codebase-design` turns DDD decisions into an implementation contract covering packages, seams, adapters, tests, and files.

It maps settled domain boundaries into code boundaries without assuming that every bounded context, aggregate, feature, or capability requires a separate code module.

## Inputs

- Architecture Spec
- `ddd-design` output
- `code-research` summary
- `effective-java-notes.md` when writing Java

## Package layout

The default Java package shape is:

```text
ui
app
domain
infra
```

- `ui` holds outward-facing entry points and presentation adapters.
- `app` holds orchestration application services only.
- `app` is the transaction boundary.
- `domain` holds entities, value objects, domain methods, domain services, aggregates, and domain policies.
- `infra` holds adapters that implement ports.

## Module Granularity

Prefer the weakest code boundary that preserves the required ownership and dependency isolation.

Do not create a code module merely to mirror:

- an aggregate,
- a domain service,
- a feature,
- a use case,
- an event-storming cluster,
- a technical operation or algorithm,
- or an internal capability.

Prefer package-level boundaries inside the owning module unless compile-time isolation provides concrete architectural value.

A new code module must have an explicit owner boundary and a meaningful public contract. For every proposed new module, answer:

1. Which bounded context owns this module?
2. Is the module itself the bounded-context boundary, or is it only an internal capability?
3. Why is a package inside the owning module insufficient?
4. Which dependency or ownership problem must compile-time isolation prevent?
5. Could this boundary plausibly support independent ownership or future deployment, if that is a project goal?
6. What contract, adapter, build, testing, and coordination cost does the new boundary introduce?

If these questions do not reveal meaningful isolation value, do not introduce a new module.

A bounded context does not require a one-to-one code module when another code boundary can preserve its required isolation. Likewise, a code module does not imply an independently deployable service.

For modular-monolith systems designed for possible future MSA extraction, optimize for clear ownership, explicit seams, and dependency direction. Do not pre-create microservice-shaped modules for internal capabilities solely to make hypothetical extraction easier.

## Process

1. Translate the `event-storming` policy output into unit-testable behavior.
2. Keep `domain` behavior in domain methods or domain services.
3. Model aggregate relationships through entity IDs, not through broad object graphs.
4. Put orchestration-only application services in `app`.
5. Put port implementations and external-system adapters in `infra`.
6. Map capabilities into packages first, then promote to modules only when the Module Granularity gate demonstrates meaningful compile-time isolation value.
7. Map the minimum set of files, modules, interfaces, seams, and tests needed to realize the design.
8. For every new module, record why the next weaker package-level boundary is insufficient and what cost the module introduces.
9. Consult `effective-java-notes.md` before writing Java code.

## Completion

- The code structure is concrete enough to implement.
- Domain decisions are not re-litigated here.
- The package shape stays `ui / app / domain / infra`.
- The transaction boundary stays in `app`.
- New modules have passed the Module Granularity gate.
- No module exists solely because a feature, aggregate, domain service, or named capability exists.
- Policy behavior is covered by unit tests.
