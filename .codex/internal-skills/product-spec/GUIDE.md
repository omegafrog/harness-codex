<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

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
   Apply [language lifecycle](../domain-modeling/references/language-lifecycle.md) to compare affected glossary definitions with the required business meaning and lifecycle. Surface implied renames, definition corrections or splits/merges without waiting for a naming request. Resolve material meaning choices in the existing interview and update settled terms in the consumer glossary; do not inspect source or retire terms on suspicion alone.
4. Run [grill-with-docs](../grill-with-docs/GUIDE.md) with that coverage checklist.
5. Ask only about material gaps that remain `PARTIAL` or `UNRESOLVED`.
6. Do not ask for descriptive facts already settled by the allowed product inputs.
7. Do ask when desired behavior, scope, exception handling, business rules, priorities, trade-offs, or acceptance conditions remain ambiguous. Existing behavior does not settle those decisions by itself.
8. Write the Product Spec only after the `grill-with-docs` completion gate passes.
9. Before declaring completion, promote settled project-wide or context-scoped canonical terms to `CONTEXT.md` and leave Spec-only wording ticket-scoped. Do not place bounded-context definitions in the glossary; those belong in `CONTEXT-MAP.md`.
10. Apply the Product diagram gate in `references/template.md`: when a user flow is created or changed, record the related use-case and activity diagram contracts; add a business-state diagram only when it has an independent business purpose. Follow the parent `spec-me` agent-routing rules. Give `spec_document_writer` the settled Product decisions, ticket scope, diagram inventory, template, `session_worktree`, and `session_directory`; require its Markdown and SVG links to stay in that worktree and add no requirements or decisions. When diagrams apply, give `diagram_creator` the settled requirements, scope, IDs, diagram inventory, and worktree paths to create diagram sources and render SVGs.

## Coverage gate

The Product Spec MUST NOT be written while any applicable topic in `references/topics.md` is `PARTIAL` or `UNRESOLVED`.

A topic may be treated as `SETTLED` only when its required product behavior is explicitly supported by authoritative input or confirmed by the user. A topic may be `NOT_APPLICABLE` only with a concrete reason.

There is no minimum question count. Question count follows unresolved coverage. Zero-question completion is allowed only under the exceptional zero-question rule defined by `grill-with-docs`.

## Completion Criteria

- Trace requirements and use cases with stable IDs.
- When a flow is newly created or changed, require the related Product use-case and activity `.puml` sources plus local SVG links in the ticket-scoped diagrams directory; a Product Spec must not create class diagrams.
- Treat `docs/specs/<ticket-id>/diagrams/product/` `.puml` files as the only editable originals and link matching SVG derivatives from the Markdown document.
- If no flow changed or a diagram is not applicable, record `해당 없음` with its reason instead of manufacturing a diagram.
- Do not complete the Product Spec until the applicable source, SVG render, Markdown link, and content-consistency checks pass. A render failure blocks completion.
- Generate `docs/specs/<ticket-id>/product-spec.md` in the format of `references/template.md`.

현재 구현 사실은 `code-research`의 입력 보고서로 전달받으며 Product 단계의 source 직접 조사 금지는 유지한다. 요구 변경은 현재 구현과 구분한다.
