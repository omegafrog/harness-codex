<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [code-research](../code-research/GUIDE.md) · [domain-modeling](../domain-modeling/GUIDE.md) · [grill-with-docs](../grill-with-docs/GUIDE.md) · [spec-review](../spec-review/GUIDE.md) · [sync-contracts](../sync-contracts/GUIDE.md).

# Product Spec

## Purpose

Turn the user request into product problems, requirements, use cases, and business rules.

## Inputs

- User request
- `CONTEXT.md`
- Read `CONTEXT-MAP.md` when present
- `references/topics.md`
- `references/template.md`
- [Language lifecycle](../domain-modeling/references/language-lifecycle.md): use current scoped canonical terms and approved retirement/replacement records. Historical Specs must not reintroduce retired vocabulary. This check uses product/glossary documents only; source/test inspection remains prohibited.

## Prohibited

- Inspecting source code
- Inspecting test code
- Deciding framework, package, persistence, or module structure
- Inferring stakeholder decisions from the current implementation

## Process

1. MUST read `references/topics.md` before starting the interview.
2. Use every topic in `references/topics.md` as the Product Spec coverage checklist.
3. Use the user request, `CONTEXT.md`, `CONTEXT-MAP.md` when present, and other allowed product documents to mark topics that are already explicitly settled.
   Compare affected glossary definitions with the required business meaning and lifecycle using the language-lifecycle proactive review. Surface implied renames, definition corrections or splits/merges without waiting for a naming request. Resolve material meaning choices in the existing interview and update settled terms in the consumer glossary; do not inspect source or retire terms on suspicion alone.
4. Run `grill-with-docs` with that coverage checklist.
5. Ask only about material gaps that remain `PARTIAL` or `UNRESOLVED`.
6. Do not ask for descriptive facts already settled by the allowed product inputs.
7. Do ask when desired behavior, scope, exception handling, business rules, priorities, trade-offs, or acceptance conditions remain ambiguous. Existing behavior does not settle those decisions by itself.
8. Write the Product Spec only after the `grill-with-docs` completion gate passes.
9. Before declaring completion, promote settled project-wide or context-scoped canonical terms to `CONTEXT.md` and leave Spec-only wording ticket-scoped. Do not place bounded-context definitions in the glossary; those belong in `CONTEXT-MAP.md`.
10. Apply the Product diagram gate in `references/template.md`: when a user flow is created or changed, record the related use-case and activity diagram contracts; add a business-state diagram only when it has an independent business purpose. Pass the planned diagram inventory to `spec_document_writer`, which writes the Spec Markdown and SVG links, then delegate diagram files and local SVG rendering to the lightweight `diagram_creator` agent using the settled Product requirements.
11. Product 다이어그램 관점은 유스케이스·액티비티와 필요 시 업무 상태이며, 클래스 다이어그램은 생성하지 않는다.

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
- `diagram_creator`만 Product 다이어그램 원본·렌더 산출물을 작성한다. `spec_document_writer`만 Product Spec Markdown을 작성한다. `product-spec`는 요구사항을 결정하고 두 서브에이전트 산출물을 검토한다.
- Generate `docs/specs/<ticket-id>/product-spec.md` in the format of `references/template.md`.
- Do not overwrite an existing ticket-scoped Product Spec without explicit approval.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

현재 구현 사실은 `code-research`의 입력 보고서로 전달받으며 Product 단계의 source 직접 조사 금지는 유지한다. 요구 변경은 현재 구현과 구분한다.

## 독립 Spec 리뷰

Product 문서·다이어그램 완료 뒤 `spec-review`의 fresh 적대적 subagent 리뷰를 통과해야 spec-me의 다음 단계/인계로 넘어간다. 직접 스킬을 실행할 때도 같은 reviewer를 호출한다. reviewer는 작성자와 다르고 전체 대화를 상속하지 않는다. 중요한 지적을 기존 interview에서 해결하고 수정본을 새 agent로 재검토한다. 부모 자체 검토는 대체 증거가 아니다.

승인 뒤 기존 plan-set에 연결된 Product 규칙을 수정하면 `harness-plan-traceability.mjs impact`를 실행한다. 입력 변경은 기존 계획 리뷰를 stale로 만들며 fresh plan review와 planning gate 전에는 구현을 dispatch하지 않는다.
