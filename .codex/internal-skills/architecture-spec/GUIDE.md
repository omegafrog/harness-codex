<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Architecture Spec

## Purpose

Turn the Product Spec into an implementable architecture contract.

## Inputs

- Completed Product Spec
- `CONTEXT.md`
- Read `CONTEXT-MAP.md` when present
- Read `docs/architecture/constraints.md` when present
- Related ADRs
- `code-research` result
- `references/topics.md`
- `references/template.md`

## Process

1. Read the Product Spec and guidance first.
2. MUST read `references/topics.md` before starting the architecture interview; use every topic as the coverage checklist.
3. Run [code-research](../code-research/GUIDE.md) to summarize the current structure and the gap from the target design. Reuse the current `domain-baseline` stage result if it covers the same workspace/commit and affected scope; refresh only changed or missing facts. Before proposing a new owner, show how the existing context/aggregate could own the change and why that is sufficient or insufficient.
4. Mark descriptive facts as settled when they are supported by the Product Spec, code-research, tests, ADRs, user-managed architecture constraints, or project documents.
5. Do not treat current implementation choices as automatically settling the target design when multiple valid architectures remain.
6. Run the [grill-with-docs](../grill-with-docs/GUIDE.md) interview with the architecture coverage checklist.
7. Ask only about material target decisions that remain `PARTIAL` or `UNRESOLVED` after evidence is considered.
8. Apply [ddd-design](../ddd-design/GUIDE.md) to affected domain concepts and capabilities. Read [model-continuity.md](../ddd-design/references/model-continuity.md) before boundary decisions. Use [event-storming](../event-storming/GUIDE.md) when the Product Spec leaves a material domain-flow question. Resolve the relevant `bounded context`, `aggregate`, `entity/value object/domain service`, state transition, repository boundary, and business-rule ownership decisions before promoting boundaries. Do not silently choose among material alternatives.
   When these decisions expose changed meaning/ownership/lifecycle, synonym duplication or one name hiding distinct concepts, apply [language lifecycle](../domain-modeling/references/language-lifecycle.md). Update settled glossary/retirement records and downstream references before completing architecture.
9. Resolve program-design and technical-architecture decisions required by `references/template.md`, including responsibilities, call contracts, interfaces, dependency rules, runtime behavior, failure handling, and integration contracts. Apply [codebase-design](../codebase-design/GUIDE.md) when package, module, or seam choices need a concrete structure; keep the Architecture Spec as the decision record.
   - Material technical choices use Architecture Decisions with separate `code` and `infrastructure` categories. Each Decision records linked requirement and System Target IDs, constraints, compared options, rejected alternatives with reasons, evidence references, rationale, trade-offs, and scaling/operations boundary. Cite the supporting source ID or exact URL and locator in the option rationale. Record user/owner agreement against the substantive Decision body hash and link the explicit Reviewer record covering all seven checklist items.
   - Decision authority references use hash-valid approved Principles and human-approved durable Evidence. Existing ADRs, approved technical standards, and technical-team guidance supply applicable constraints and source evidence. Keep candidate/reviewed Principles informational. Final Architecture Spec and ADR handoff retains accepted Decision, target, Principle, Evidence, and source locators; a deprecated Principle marks citing Decisions review-required while preserving their prior approval and history.
   - ReviewRecord에 자료 사용 승인 기록이 연결되면 `material_approval.approval_id`에 승인 기록 ID만 참조한다. 자료 탐색·제시·사용 승인 workflow는 knowledge plan에서 다룬다.
   - Same-ID Knowledge edits from independent worktrees are compared against base/ours/theirs. Report divergent body or approval changes for explicit user resolution; never choose a last writer or lock an in-progress worktree.
10. When applicable, pass the planned independent class and design-state diagram inventory to `spec_document_writer`, which writes the Architecture Spec Markdown and SVG links, then delegate diagrams that reflect the settled design to `diagram_creator`. Follow the parent `spec-me` agent-routing rules. Supply the settled design, exact IDs, and ticket scope; diagrams show relationships, responsibilities, state transitions, and transition conditions rather than repeat the tables. Do not duplicate a Product business-state diagram when it has the same purpose.
11. Write the Architecture Spec only after the `grill-with-docs` completion gate passes.
12. Before declaring completion, promote settled project-wide or context-scoped canonical terms to `CONTEXT.md`; record settled bounded-context names, responsibilities, and relationships in `CONTEXT-MAP.md`. Keep architecture-only temporary wording in the ticket-scoped Spec.
13. Reconcile affected durable model entries and linked diagrams under the model-continuity rules. Record approved changes as `accepted-target` with their Spec/decision reference, preserving current `implemented` facts until verified implementation. Pass rule IDs, owners/enforcement, communication/deployment decisions and relevant System Targets into planning.

## Coverage gate

The Architecture Spec MUST NOT be written while any applicable topic in `references/topics.md` is `PARTIAL` or `UNRESOLVED`.

A target design decision is `SETTLED` only when one of the following is true:

- It is constrained to one valid outcome by the completed Product Spec and authoritative architecture evidence.
- It is already established by an applicable ADR or explicit project constraint.
- The user explicitly confirms the decision.

Code-research may settle facts about the current architecture. It does not by itself settle a future architecture choice merely because the current code already uses one option.

There is no minimum question count. Question count follows unresolved coverage. Zero-question completion is allowed only under the exceptional zero-question rule defined by `grill-with-docs`.

## Completion Criteria

- Generate `docs/specs/<ticket-id>/architecture-spec.md` in the format of `references/template.md`.
- For applicable structure, create independent `.puml` originals and matching SVGs under `docs/specs/<ticket-id>/diagrams/architecture/`; use the class and design-state filename/ID/link rules in `references/template.md`.
- Include a class diagram and/or design-state diagram when applicable. If either structure does not apply, state `해당 없음` and provide the reason. Do not duplicate an equivalent Product business-state diagram.
- Do not complete the Architecture Spec until source, local SVG render, Markdown SVG link, and content-consistency checks pass. A render failure blocks completion.
- `diagram_creator`만 Architecture 다이어그램 원본·렌더 산출물을 작성한다. `spec_document_writer`만 Architecture Spec Markdown을 작성한다. `architecture-spec`는 설계 결정을 정하고 두 서브에이전트 산출물을 검토한다.

설계가 실행 인자·설정·인프라 의존성을 바꾸면 실제 source/CI와 실행 계약을 확인하고 execution.json profile·EXEC의 갱신 책임을 codebase impact에 포함한다. 테스트·서비스 시작은 harness-exec의 최신 설정 검증과 readiness를 통과해야 한다.
