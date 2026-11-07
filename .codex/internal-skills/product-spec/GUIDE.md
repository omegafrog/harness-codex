<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Product Spec

## 실행 모델과 반환

기본 `model_tier`는 `low`이며 `agents.low_performance_model`와 `agents.low_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [실행 조율](../skill-execution/GUIDE.md)에 따라 `harness-skill-execution.mjs binding`이 스킬의 binding과 setup 설정에서 model·effort를 해석한다. 지정된 작업을 수행하고 필요한 내부 작업은 [실행 조율](../skill-execution/GUIDE.md)에 따라 서브에이전트에 위임한다. 사용자 결정과 workflow 단계 전환은 상위 caller에 반환한다.

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

This is a phase-local guide. Read it when the Product phase begins; do not preload Architecture, review, or diagram instructions while interviewing.

`spec-me`는 아래 절차로 확정한 요구사항과 template을 사용해 Product Spec을 작성하고 리뷰 지적에 따라 수정한다.

1. MUST read `references/topics.md` before starting the interview.
2. Use every topic in `references/topics.md` as the Product Spec coverage checklist.
3. Use the user request, `CONTEXT.md`, `CONTEXT-MAP.md` when present, and other allowed product documents to mark topics that are already explicitly settled.
   Apply [language lifecycle](../domain-modeling/references/language-lifecycle.md) to compare affected glossary definitions with the required business meaning and lifecycle. Surface implied renames, definition corrections or splits/merges without waiting for a naming request. Resolve material meaning choices in the existing interview and update settled terms in the consumer glossary; do not inspect source or retire terms on suspicion alone.
4. Run [grill-with-docs](../grill-with-docs/GUIDE.md) with that coverage checklist in `spec-me` batch mode. Before the first question and after each response batch, examine every applicable topic and collect all currently answerable independent material decisions; return them together. Only defer questions whose answers depend on an unresolved prerequisite.
5. Ask only about material gaps that remain `PARTIAL` or `UNRESOLVED`.
6. Do not ask for descriptive facts already settled by the allowed product inputs.
7. Ask about an ambiguity only when it is necessary to deliver the requested core behavior, materially changes the outcome, and cannot be resolved from existing evidence or a reasonable platform default. Do not introduce optional features or policies to fill a coverage topic. Existing behavior alone does not override explicit user intent.
8. Write the Product Spec only after the `grill-with-docs` completion gate passes.
   Preserve the user's wording of limits and rules; "5,000자" stays "5,000자". Do not introduce an unstated unit, encoding, normalization, locale, or stricter precision unless it is necessary for the requested outcome; otherwise keep the plain meaning. Carry the reason behind an approved option into that rule's `의도`. Record the actual basis of a reasonable default and never present it as a user decision. Ask only if a necessary material choice cannot be resolved from the available evidence or a reasonable default.
9. Treat every business concept, actor/role, business state, and rule term defined in Product Spec section 4 as the consumer project's ubiquitous language, shared across the project rather than owned by this plan set. Add or update each entry in the active workspace's `CONTEXT.md`, preserving its existing table and language lifecycle. Reuse the current canonical term when its meaning matches; update its definition when approved behavior changes; record an approved replacement in the retired-term table. Do not leave a term defined only in the ticket-scoped Spec. Keep explanatory phrases and UI copy that do not name a domain concept in the Spec. Record bounded-context responsibilities and relationships in `CONTEXT-MAP.md`, not as glossary definitions.
10. Apply the Product diagram contract in `references/template.md`: when a user flow is created or changed, record the related use-case and activity diagram inventory; add a business-state diagram only when it has an independent business purpose. The Spec author records the final diagram IDs and links to both `.puml` originals and SVG targets in Markdown but does not dispatch diagram creation. The spec-me workflow creates diagrams after the Architecture review gate passes; `diagram_creator` uses the finalized Specs and does not make product decisions.

## Coverage gate

The Product Spec MUST NOT be written while a topic necessary for the requested core behavior has a material unresolved decision that cannot be reasonably resolved from existing evidence or platform defaults.

A topic may be treated as `SETTLED` when its required product behavior is supported by authoritative input, confirmed by the user, or resolved with a recorded reasonable default that does not add an unrequested feature. A topic may be `NOT_APPLICABLE` when it is outside the requested scope; record the reason.

There is no minimum question count. Ask about unresolved business behavior and scope, and apply the `grill-with-docs` completion rule; settled or explicitly delegated choices need no repeated confirmation.

## Completion Criteria

- Trace requirements and use cases with stable IDs.
- When a flow is newly created or changed, declare the related Product use-case and activity `.puml` sources plus SVG link targets in the ticket-scoped diagrams directory; a Product Spec must not create class diagrams.
- Treat `docs/specs/<plan-set-id>/diagrams/product/` `.puml` files as the only editable originals. Link each original and its matching SVG derivative from the Product Spec using relative Markdown links.
- If no flow changed or a diagram is not applicable, record `해당 없음` with its reason instead of manufacturing a diagram.
- The independent Architecture review checks the frozen Architecture Spec against the Product Spec and project evidence. The final spec-me diagram stages validate applicable sources, SVG renders, Markdown links, and content consistency after the Architecture review and decision gates pass; a render failure blocks workflow completion.
- Generate `docs/specs/<plan-set-id>/product-spec.md` in the format of `references/template.md`.

현재 구현 사실은 `code-research`의 입력 보고서로 전달받으며 Product 단계의 source 직접 조사 금지는 유지한다. 요구 변경은 현재 구현과 구분한다.

기술 선택 전 적용 가능한 기능·구축 시간·운영·비용·데이터 제어·성능·변경 가능성 기준을 필수와 선호, 우선순위로 정한다. 기존 사용자 답변과 명시적 위임을 재사용하고 독립 질문을 묶는다.
