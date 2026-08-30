---
name: spec-me
description: Turn a user request into Product Spec and Architecture Spec, then recommend to-ticket without jumping to implementation.
---

# spec-me

## What it does

`spec-me` turns a user request into Product Spec and Architecture Spec, then recommends `to-ticket`.

If the request is about broken behavior, flaky regression, or performance regression, `spec-me` is not the right on-ramp; use `diagnosing-bugs` instead.

## Flow

1. Run `product-spec`, which uses `grill-with-docs`.
2. Run `architecture-spec`, which uses `grill-with-docs`.
3. Use `event-storming`, `ddd-design`, and `codebase-design` as needed inside the architecture step.
4. Stop after Product Spec and Architecture Spec are complete.
5. Recommend `to-ticket`, but do not call it automatically.

## Documents

- Write the completed Product Spec to `docs/specs/<ticket-id>/product-spec.md` using the `product-spec` template.
- Write the completed Architecture Spec to `docs/specs/<ticket-id>/architecture-spec.md` using the `architecture-spec` template.
- Create `docs/specs/<ticket-id>/` when missing.
- Resolve the ticket ID before writing the specs.
- Do not overwrite an existing ticket-scoped spec without explicit user approval.
- Do not claim either stage is complete until its document exists.

## Rules

- Product Spec does not inspect source or test code.
- Architecture Spec does inspect current code and test structure.
- `CONTEXT.md` is glossary only.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.
