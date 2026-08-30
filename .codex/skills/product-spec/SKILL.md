---
name: product-spec
description: Convert a user request into product requirements, use cases, and business rules without making implementation decisions. Use before architecture design.
---

# Product Spec

## Purpose

Turn the user request into product problems, requirements, use cases, and business rules.

## Inputs

- User request
- `CONTEXT.md`
- Read `CONTEXT-MAP.md` when present

## Prohibited

- Inspecting source code
- Inspecting test code
- Deciding framework, package, persistence, or module structure

## Process

1. Run `/grill-with-docs`.
2. Do not ask about facts that can be confirmed from the repository.
3. Write the Product Spec when the questions sufficiently cover the topic.

## Connection

- `grill-with-docs` is the public wrapper for the product interview.
- `product-spec` turns the interview results into a product document.

## Completion Criteria

- Do not include code structure or implementation details in the Product Spec.
- Trace requirements and use cases with stable IDs.
- Generate `docs/specs/<ticket-id>/product-spec.md` in the format of `references/template.md`.
- Do not overwrite an existing ticket-scoped Product Spec without explicit approval.
