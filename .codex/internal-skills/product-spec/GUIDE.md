<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Product Spec

## 실행 모델과 반환

기본 `model_tier`는 `low`이며 `agents.low_performance_model`와 `agents.low_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [공통 skill 실행 계약](../skill-execution/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

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
10. Apply the Product diagram contract in `references/template.md`: when a user flow is created or changed, record the related use-case and activity diagram inventory; add a business-state diagram only when it has an independent business purpose. The writer records the final diagram IDs and SVG link targets in Markdown but does not dispatch diagram creation. The spec-me workflow creates diagrams after the Architecture review gate passes; `diagram_creator` uses the finalized Specs and does not make product decisions.

## Coverage gate

The Product Spec MUST NOT be written while any applicable topic in `references/topics.md` is `PARTIAL` or `UNRESOLVED`.

A topic may be treated as `SETTLED` only when its required product behavior is explicitly supported by authoritative input or confirmed by the user. A topic may be `NOT_APPLICABLE` only with a concrete reason.

There is no minimum question count. Question count follows unresolved coverage. Zero-question completion is allowed only under the exceptional zero-question rule defined by `grill-with-docs`.

## Completion Criteria

- Trace requirements and use cases with stable IDs.
- When a flow is newly created or changed, declare the related Product use-case and activity `.puml` sources plus SVG link targets in the ticket-scoped diagrams directory; a Product Spec must not create class diagrams.
- Treat `docs/specs/<ticket-id>/diagrams/product/` `.puml` files as the only editable originals and link matching SVG derivatives from the Markdown document.
- If no flow changed or a diagram is not applicable, record `해당 없음` with its reason instead of manufacturing a diagram.
- The independent Architecture review checks the frozen Architecture Spec against the Product Spec and project evidence. The final spec-me diagram stages validate applicable sources, SVG renders, Markdown links, and content consistency after the Architecture review and decision gates pass; a render failure blocks workflow completion.
- Generate `docs/specs/<ticket-id>/product-spec.md` in the format of `references/template.md`.

현재 구현 사실은 `code-research`의 입력 보고서로 전달받으며 Product 단계의 source 직접 조사 금지는 유지한다. 요구 변경은 현재 구현과 구분한다.
