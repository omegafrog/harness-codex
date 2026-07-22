---
name: codebase-design
description: Translate DDD decisions into concrete packages, seams, adapters, files, and tests. Use after architecture design and before implementation planning.
---

# codebase-design

## What it does

`codebase-design` turns the DDD shape into an implementation contract for the codebase. It decides which packages, seams, adapters, tests, and files change, without reopening the DDD decisions themselves.

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

## Process

1. Translate the `event-storming` policy output into unit-testable behavior.
2. Keep `domain` behavior in domain methods or domain services.
3. Model aggregate relationships through entity IDs, not through broad object graphs.
4. Put orchestration-only application services in `app`.
5. Put port implementations and external-system adapters in `infra`.
6. Map the minimum set of files, modules, interfaces, seams, and tests needed to realize the design.
7. Consult `effective-java-notes.md` before writing Java code.

## Completion

- The code structure is concrete enough to implement.
- Domain decisions are not re-litigated here.
- The package shape stays `ui / app / domain / infra`.
- The transaction boundary stays in `app`.
- Policy behavior is covered by unit tests.
