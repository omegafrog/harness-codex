---
name: spec-me
description: Turn a user request into Product Spec and Architecture Spec, then recommend to-ticket without jumping to implementation.
---

# spec-me

## What it does

`spec-me` is the public entrypoint for turning a user request into Product Spec and Architecture Spec. It does not jump straight to implementation. It first asks for product understanding, then for architecture shape, and only then recommends `to-ticket`.

If the request is about broken behavior, flaky regression, or performance regression, `spec-me` is not the right on-ramp; use `diagnosing-bugs` instead.

## Flow

1. If `CONTEXT.md` or `CONTEXT-MAP.md` is missing, run `setup` before continuing.
2. Run `product-spec`, which uses `grill-with-docs`.
3. Run `architecture-spec`.
4. Use `event-storming`, `ddd-design`, and `codebase-design` as needed inside the architecture step.
5. Stop after Product Spec and Architecture Spec are complete.
6. Recommend `to-ticket`, but do not call it automatically.

## Rules

- Product Spec does not inspect source or test code.
- Architecture Spec does inspect current code and test structure.
- `CONTEXT.md` is glossary only.
- ADRs are created only when a decision is worth keeping.

## Pulled out on purpose

`spec-me` is the user-facing wrapper for the design flow. It keeps the public surface small while delegating the actual design work to the internal skills.
