---
name: spec-me
description: Turn a user request into Product Spec and Architecture Spec, then recommend to-ticket without jumping to implementation.
---

# spec-me

## What it does

`spec-me` turns a user request into Product Spec and Architecture Spec, then recommends `to-ticket`.

If the request is about broken behavior, flaky regression, or performance regression, `spec-me` is not the right on-ramp; use `diagnosing-bugs` instead.

## Flow

1. Run `product-spec`.
2. Do not advance until the Product Spec coverage gate has passed and `docs/specs/<ticket-id>/product-spec.md` exists.
3. Run `architecture-spec` using the completed Product Spec.
4. Use `event-storming`, `ddd-design`, and `codebase-design` as needed inside the architecture step.
5. Do not advance until the Architecture Spec coverage gate has passed and `docs/specs/<ticket-id>/architecture-spec.md` exists.
6. Stop after Product Spec and Architecture Spec are complete.
7. Recommend `to-ticket`, but do not call it automatically.

## Interview gates

Both specification stages are coverage-driven interviews through `grill-with-docs`.

- `product-spec` owns the Product Spec coverage checklist.
- `architecture-spec` owns the Architecture Spec coverage checklist.
- `grill-with-docs` owns the one-question-at-a-time interview loop and completion gate.
- `spec-me` MUST NOT bypass, shorten, or reinterpret either stage's coverage gate merely to complete the workflow in one pass.
- If a stage still has a material `PARTIAL` or `UNRESOLVED` topic, remain in that stage and continue the interview after the user's next answer.
- Do not manufacture a minimum number of questions. The gate is coverage, not question count.
- Zero-question completion is allowed only when the stage satisfies the exceptional zero-question rule in `grill-with-docs`.

## Documents

- Write the completed Product Spec to `docs/specs/<ticket-id>/product-spec.md` using the `product-spec` template.
- Write the completed Architecture Spec to `docs/specs/<ticket-id>/architecture-spec.md` using the `architecture-spec` template.
- Create `docs/specs/<ticket-id>/` when missing.
- Resolve the ticket ID before writing the specs.
- Do not overwrite an existing ticket-scoped spec without explicit user approval.
- Do not claim either stage is complete until both its interview coverage gate has passed and its document exists.

## Rules

- Product Spec does not inspect source or test code.
- Architecture Spec does inspect current code and test structure.
- Current implementation may settle descriptive facts but does not automatically settle desired product behavior or a material target architecture decision.
- `CONTEXT.md` is glossary only.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.
