<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [code-research](../code-research/GUIDE.md) · [ddd-design](../ddd-design/GUIDE.md) · [domain-modeling](../domain-modeling/GUIDE.md) · [event-storming](../event-storming/GUIDE.md) · [grill-with-docs](../grill-with-docs/GUIDE.md) · [spec-review](../spec-review/GUIDE.md) · [sync-contracts](../sync-contracts/GUIDE.md).

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
- [Model continuity contract](../ddd-design/references/model-continuity.md); read it before boundary decisions and use its current-model baseline, encapsulation, communication, deployment, and update rules.

## Process

1. Read the Product Spec and guidance first.
2. MUST read `references/topics.md` before starting the architecture interview.
3. Run `code-research` to summarize the current structure and the gap from the target design. Reuse the current `domain-baseline` stage result if it covers the same workspace/commit and affected scope; refresh only changed or missing facts. Before proposing a new owner, show how the existing context/aggregate could own the change and why that is sufficient or insufficient.
4. Use every topic in `references/topics.md` as the Architecture Spec coverage checklist.
5. Mark descriptive facts as settled when they are supported by the Product Spec, code-research, tests, ADRs, user-managed architecture constraints, or project documents.
6. Do not treat current implementation choices as automatically settling the target design when multiple valid architectures remain.
7. Run the `grill-with-docs` interview with the architecture coverage checklist.
8. Ask only about material target decisions that remain `PARTIAL` or `UNRESOLVED` after evidence is considered.
9. For DDD design, classify domain concepts and capabilities before promoting boundaries. Resolve and confirm the relevant `bounded context`, `aggregate`, `entity/value object/domain service`, state transition, repository boundary, and business-rule ownership decisions. Do not silently choose among material alternatives.
   Reassess affected vocabulary when these decisions expose changed meaning/ownership/lifecycle, synonym duplication or one name hiding distinct concepts. Apply the [proactive language review](../domain-modeling/references/language-lifecycle.md); do not require the user to first request a rename. Established glossary wording is a baseline to reassess against the settled model, not an immutable naming constraint. Update settled glossary/retirement records and downstream references before completing architecture.
10. Resolve program-design and technical-architecture decisions required by `references/template.md`, including responsibilities, call contracts, interfaces, dependency rules, runtime behavior, failure handling, integration contracts, and the weakest sufficient code/runtime boundary where applicable.
   - Engineering Decision이 opt-in된 경우 `code`와 `infrastructure`를 별도 범주로 유지한다. 각 결정에는 연결된 requirement 및 System Target ID, constraints, options, 이유가 포함된 rejected alternatives, evidence refs, rationale, tradeoffs, scaling/operations boundary를 기록한다. 사용자의 결정 승인은 해당 결정 substantive body의 canonical SHA-256 hash에 연결하고, 공통 7개 검토 항목을 확인한 명시적 Reviewer record를 연결한다. 참조 evidence의 본문 변경은 결정 자체 hash를 바꾸지 않는다.
   - Authority refs contain only hash-valid approved Principles and human-approved durable Evidence. Keep candidate/reviewed Principles informational. Final Architecture/ADR handoff retains accepted Decision, target, Principle, and Evidence IDs; a deprecated Principle marks citing Decisions review-required while preserving their prior approval and history.
   - ReviewRecord에 자료 사용 승인 기록이 연결되면 `material_approval.approval_id`에 승인 기록 ID만 참조한다. 자료 탐색·제시·사용 승인 workflow는 knowledge plan에서 다룬다.
   - Same-ID Knowledge edits from independent worktrees are compared against base/ours/theirs. Report divergent body or approval changes for explicit user resolution; never choose a last writer or lock an in-progress worktree.
11. When applicable, pass the planned 독립적인 클래스(class) and 설계 상태(design-state) diagram inventory to `spec_document_writer`, which writes the Architecture Spec Markdown and SVG links, then delegate diagrams that reflect the settled design to the lightweight `diagram_creator` agent. Supply the settled design, exact IDs, and ticket scope; the diagrams must show relationships, responsibilities, state transitions, and transition conditions rather than repeat the tables; do not duplicate a Product business-state diagram when the purpose is the same.
12. Write the Architecture Spec only after the `grill-with-docs` completion gate passes.
13. Before declaring completion, promote settled project-wide or context-scoped canonical terms to `CONTEXT.md`; record settled bounded-context names, responsibilities, and relationships in `CONTEXT-MAP.md`. Keep architecture-only temporary wording in the ticket-scoped Spec.
14. Reconcile affected durable model entries and linked diagrams under the model continuity contract. Record approved changes as `accepted-target` with their Spec/decision reference, preserving current `implemented` facts until verified implementation. Pass rule IDs, owners/enforcement, communication/deployment decisions and relevant System Targets into planning.

## Boundary Granularity

Boundary creation is promotion, not decomposition.

A domain concept MUST NOT automatically become a bounded context, code module, or independently deployable service. Treat the following as different levels of architectural strength:

```text
Domain concept
→ Entity / Value Object / Domain Service
→ Aggregate
→ Internal capability
→ Bounded Context
→ Code module
→ Deployment service
```

Use the weakest boundary that preserves the required ownership, consistency, dependency isolation, and runtime properties. The default is to keep a capability inside an existing bounded context when that context can own the capability coherently.

Do not promote a concept to a stronger boundary merely because:

- it has a distinct name,
- it has multiple classes,
- it participates in event-storming,
- it contains domain logic,
- it has its own aggregate or domain service,
- it could theoretically expose an API,
- or it may be reusable.

Promote a capability to a new bounded context only when there is material evidence of autonomous domain ownership, such as:

- a distinct ubiquitous language or model whose meaning differs from neighboring contexts,
- independent business rules and invariants,
- independent state or data lifecycle,
- an independent consistency or transaction boundary,
- meaningful change independence,
- or a clear upstream/downstream relationship that requires translation.

Strong signals against creating a separate bounded context include:

- the capability exists primarily to support another context's use cases,
- it has no independently owned state or data lifecycle,
- most calls would be synchronous and occur inside another context's workflow,
- correctness requires frequent cross-boundary transactions,
- it cannot meaningfully operate without the parent context,
- its vocabulary has the same meaning as the parent context,
- or the boundary is primarily around a technical operation, algorithm, or named feature.

Promote a bounded context to a separate code module only when compile-time isolation provides concrete architectural value. Promote a module to an independently deployable service only when independent deployment, scaling, failure isolation, ownership, or operational lifecycle is a plausible requirement.

For every proposed new bounded context, module, or service, explicitly explain why the next weaker boundary is insufficient and what cost the stronger boundary introduces.

When the target system starts as a modular monolith and may evolve toward MSA, preserve explicit context ownership and contracts without pre-creating a service for every capability. Extraction readiness means preserving ownership and seams, not mirroring every domain concept as a deployment boundary.

## Coverage gate

The Architecture Spec MUST NOT be written while any applicable topic in `references/topics.md` is `PARTIAL` or `UNRESOLVED`.

A target design decision is `SETTLED` only when one of the following is true:

- It is constrained to one valid outcome by the completed Product Spec and authoritative architecture evidence.
- It is already established by an applicable ADR or explicit project constraint.
- The user explicitly confirms the decision.

Code-research may settle facts about the current architecture. It does not by itself settle a future architecture choice merely because the current code already uses one option.

There is no minimum question count. Question count follows unresolved coverage. Zero-question completion is allowed only under the exceptional zero-question rule defined by `grill-with-docs`.

## Connection

- `architecture-spec` owns the architecture coverage checklist, evidence gathering, and document contract.
- `grill-with-docs` owns the interactive question loop and interview completion gate.
- `code-research` settles current-system facts; it does not replace stakeholder confirmation of material target decisions.

## Completion Criteria

- Every applicable topic in `references/topics.md` is settled.
- No material architecture decision is based only on model preference or inference.
- Every new bounded context, module, or service has passed the boundary-promotion test and documents why a weaker boundary is insufficient.
- No blocking design decision, contradiction, risk requiring a decision, or open question remains.
- Settled vocabulary and bounded-context changes are reflected in `CONTEXT.md` and/or `CONTEXT-MAP.md` according to the durable-vocabulary placement rules.
- Do not hide mismatches between the code and requirements.
- Do not ask again about facts already settled in the Product Spec or authoritative evidence.
- Do not copy the full code-research transcript into the Architecture Spec.
- Generate `docs/specs/<ticket-id>/architecture-spec.md` in the format of `references/template.md`.
- For applicable structure, create independent `.puml` originals and matching SVGs under `docs/specs/<ticket-id>/diagrams/architecture/`; use the class and design-state filename/ID/link rules in `references/template.md`.
- Include a class diagram and/or design-state diagram when applicable. If either structure does not apply, state `해당 없음` and provide the reason. Do not duplicate an equivalent Product business-state diagram.
- Do not complete the Architecture Spec until source, local SVG render, Markdown SVG link, and content-consistency checks pass. A render failure blocks completion.
- `diagram_creator`만 Architecture 다이어그램 원본·렌더 산출물을 작성한다. `spec_document_writer`만 Architecture Spec Markdown을 작성한다. `architecture-spec`는 설계 결정을 정하고 두 서브에이전트 산출물을 검토한다.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

설계가 실행 인자·설정·인프라 의존성을 바꾸면 실제 source/CI와 실행 계약을 확인하고 execution.json profile·EXEC의 갱신 책임을 codebase impact에 포함한다. 테스트·서비스 시작은 harness-exec의 최신 설정 검증과 readiness를 통과해야 한다.

## 독립 Spec 리뷰

Architecture 문서·다이어그램 완료 뒤 `spec-review`의 fresh 적대적 subagent 리뷰를 통과해야 spec-me의 다음 단계/인계로 넘어간다. 직접 스킬을 실행할 때도 같은 reviewer를 호출한다. reviewer는 작성자와 다르고 전체 대화를 상속하지 않는다. 중요한 지적을 기존 interview에서 해결하고 수정본을 새 agent로 재검토한다. 부모 자체 검토는 대체 증거가 아니다.

승인 뒤 기존 plan-set에 연결된 Architecture 규칙·결정·다이어그램을 수정하면 `harness-plan-traceability.mjs impact`를 실행한다. 입력 변경은 기존 계획 리뷰를 stale로 만들며 fresh plan review와 planning gate 전에는 구현을 dispatch하지 않는다.
