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
- `references/topics.md`
- `references/template.md`

## Prohibited

- Inspecting source code
- Inspecting test code
- Deciding framework, package, persistence, or module structure
- Inferring stakeholder decisions from the current implementation

## Process

1. MUST read `references/topics.md` before starting the interview.
2. Use every topic in `references/topics.md` as the Product Spec coverage checklist.
3. Use the user request, `CONTEXT.md`, `CONTEXT-MAP.md` when present, and other allowed product documents to mark topics that are already explicitly settled.
4. Run `/grill-with-docs` with that coverage checklist.
5. Ask only about material gaps that remain `PARTIAL` or `UNRESOLVED`.
6. Do not ask for descriptive facts already settled by the allowed product inputs.
7. Do ask when desired behavior, scope, exception handling, business rules, priorities, trade-offs, or acceptance conditions remain ambiguous. Existing behavior does not settle those decisions by itself.
8. Write the Product Spec only after the `grill-with-docs` completion gate passes.
9. Apply the Product diagram gate in `references/template.md`: when a user flow is created or changed, record the related use-case and activity diagram contracts; add a business-state diagram only when it has an independent business purpose.
10. Product 다이어그램 관점은 유스케이스·액티비티와 필요 시 업무 상태이며, 클래스 다이어그램은 생성하지 않는다.

## Coverage gate

The Product Spec MUST NOT be written while any applicable topic in `references/topics.md` is `PARTIAL` or `UNRESOLVED`.

A topic may be treated as `SETTLED` only when its required product behavior is explicitly supported by authoritative input or confirmed by the user. A topic may be `NOT_APPLICABLE` only with a concrete reason.

There is no minimum question count. Question count follows unresolved coverage. Zero-question completion is allowed only under the exceptional zero-question rule defined by `grill-with-docs`.

## Connection

- `product-spec` owns the Product Spec coverage checklist and document contract.
- `grill-with-docs` owns the interactive question loop and interview completion gate.
- `product-spec` turns the settled interview results into a product document.

## Completion Criteria

- Every applicable topic in `references/topics.md` is settled.
- No material product decision is based only on model inference.
- No blocking contradiction or open product decision remains.
- Do not include code structure or implementation details in the Product Spec.
- Trace requirements and use cases with stable IDs.
- When a flow is newly created or changed, require the related Product use-case and activity `.puml` sources plus local SVG links in the ticket-scoped diagrams directory; a Product Spec must not create class diagrams.
- 흐름 신설·변경 시 관련 유스케이스·액티비티 다이어그램을 검토한다.
- Treat `docs/specs/<ticket-id>/diagrams/product/` `.puml` files as the only editable originals and link matching SVG derivatives from the Markdown document.
- If no flow changed or a diagram is not applicable, record `해당 없음` with its reason instead of manufacturing a diagram.
- Do not complete the Product Spec until the applicable source, SVG render, Markdown link, and content-consistency checks pass. A render failure blocks completion.
- Generate `docs/specs/<ticket-id>/product-spec.md` in the format of `references/template.md`.
- Do not overwrite an existing ticket-scoped Product Spec without explicit approval.
