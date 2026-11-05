<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Architecture Spec

## 실행 모델과 반환

기본 `model_tier`는 `low`이며 `agents.low_performance_model`와 `agents.low_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [실행 조율](../skill-execution/GUIDE.md)에 따라 필요한 하위 작업을 서브에이전트에 위임하고 결과 파일과 공통 envelope를 반환한다. 사용자 결정과 workflow 단계 전환은 상위 caller에 반환한다.

독립 리뷰는 현재 부모 Codex 대화에서 지정된 native reviewer를 직접 호출한다. `review_request`는 reviewer의 `skill`, `agent_profile`, 범위와 `context_path`를 담는 입력 계약이며, `context_path`는 확인된 Decision ID, review mode, 사용자 주장과 근거를 담은 session 상대 JSON이다. native reviewer의 결과를 직접 검토해 findings를 해결하고, 필요한 사용자 선택은 부모 stage의 `USER_DECISION_REQUIRED` 경계로 반환한다. 재검토에는 이전 보고서의 변경 구간과 미해결 finding을 포함한다. reviewer 출력은 session 산출물로 보존하며 `context.review_result_ref`나 별도 child-stage dispatch를 사용하지 않는다.

## Purpose

Turn the Product Spec into an implementable architecture contract.

## Inputs

- 완료된 Product Spec: 전달된 경로를 사용하며, spec-me 기본 경로는 `docs/specs/<plan-set-id>/product-spec.md`다
- `CONTEXT.md`
- Read `CONTEXT-MAP.md` when present
- Read `docs/architecture/constraints.md` when present
- Related ADRs
- `code-research` result
- `references/topics.md`
- `references/template.md`
- `../spec-review/references/review-criteria.md`

Architecture Spec drafting does not execute tests, services, or infrastructure and does not require `docs/agents/EXEC.md` or `docs/agents/execution.json` to exist. When a proposed decision changes how the application is launched or verified, inspect those files if present and record any missing execution-contract work in the implementation impact; do not block Spec authoring on that preparation.

## Process

`spec-me`는 아래 절차로 확정한 결정과 근거를 template에 반영해 Architecture Spec을 작성하고 리뷰 지적에 따라 수정한다.

1. Read the Product Spec and guidance first.
2. MUST read `references/topics.md` before starting the architecture interview; use every topic as the coverage checklist.
3. MUST read [Architecture Spec review criteria](../spec-review/references/review-criteria.md), [DDD model continuity](../ddd-design/references/model-continuity.md), and [testing guidance](../testing-guidance/GUIDE.md) before writing. Use the criteria to connect Product behavior, DDD ownership, business-rule unit-test cases, technology choices, evidence, and required infrastructure before handing off the frozen Spec.
4. Run [code-research](../code-research/GUIDE.md) to summarize the current structure and the gap from the target design. Reuse the current `domain-baseline` stage result if it covers the same workspace/commit and affected scope; refresh only changed or missing facts. Before proposing a new owner, show how the existing context/aggregate could own the change and why that is sufficient or insufficient.
5. Mark descriptive facts as settled when they are supported by the Product Spec, code-research, tests, ADRs, user-managed architecture constraints, or project documents.
6. Do not treat current implementation choices as automatically settling the target design when multiple valid architectures remain.
7. Run the [grill-with-docs](../grill-with-docs/GUIDE.md) interview with the architecture coverage checklist.
8. Apply the [grilling](../../../.agents/skills/grilling/SKILL.md) question criteria to unresolved architecture topics after considering evidence and prior user choices or delegation. Resolve implementation details within the approved design and record the engineering rationale without attributing invented reasons to the user.
9. Apply [ddd-design](../ddd-design/GUIDE.md) to affected domain concepts. Read [model-continuity.md](../ddd-design/references/model-continuity.md) before boundary decisions. Use [event-storming](../event-storming/GUIDE.md) when the Product Spec leaves a material domain-flow question. Identify Entity/Value Object behavior, Aggregate roots and invariants, application service coordination, and then compare Bounded Context candidates by language, model, rule/data ownership, lifecycle, consistency, change and translation. Preserve current implementation facts separately from the target. Explain Context and deployment choices independently.
   When these decisions expose changed meaning/ownership/lifecycle, synonym duplication or one name hiding distinct concepts, apply [language lifecycle](../domain-modeling/references/language-lifecycle.md). Update settled glossary/retirement records and downstream references before completing architecture.
10. 변경되는 상태 보유 operation의 정상·경합·부분 실패·재시도·재시작·복구를 `references/template.md`의 경합·실패·복구 전이 표에서 함께 대조한다. 한 경로를 고치면서 추가된 예약·잠금·버전 조건이 다른 허용 명령과 복구를 막는지 확인하고 중대한 미결정을 해결한다.
   Resolve program-design and technical-architecture decisions required by `references/template.md`, including responsibilities, call contracts, interfaces, dependency rules, runtime behavior, failure handling, and integration contracts. Apply [codebase-design](../codebase-design/GUIDE.md) when package, module, or seam choices need a concrete structure; keep the Architecture Spec as the decision record.
   - Material technology choices use the conditional [technology selection guide](../technology-selection/GUIDE.md). Record criteria, comparable evaluations, source conditions, user choice or explicit delegation and accepted trade-offs in the canonical Decision; reuse valid existing decisions. Ordinary cited sources do not require Knowledge publication. Learning review is separate and only applies when requested.
   - Same-ID Knowledge edits from independent worktrees are compared against base/ours/theirs. Report divergent body or approval changes for explicit user resolution; never choose a last writer or lock an in-progress worktree.
11. When applicable, record the planned independent class and design-state diagram inventory in the Spec, including final diagram IDs and SVG link targets in the Architecture Spec Markdown. Do not dispatch diagram creation during Spec drafting or review revisions. After the final Specs are stable and the Architecture review passes, the spec-me workflow delegates the frozen design to `diagram_creator`, which shows relationships, responsibilities, state transitions, and transition conditions rather than repeating tables. Do not duplicate a Product business-state diagram when it has the same purpose.
12. Write the Architecture Spec only after the `grill-with-docs` completion gate passes.
   Use the template's Domain → Aggregate → Application Service → Bounded Context order. Keep Product-to-Architecture mapping in the optional trailing appendix, put resolved hotspots in their owning model or decision, and express each application flow as an ordered list. Use 기능 or 책임 for generic capabilities. Keep security, observability, runtime, and deployment decisions in their relevant supporting sections.
13. Before declaring completion, compare every Architecture domain model, role, state, and business-rule term with the project's shared `CONTEXT.md`. Add newly settled domain vocabulary and update definitions whose meaning changed; approved replacements follow the glossary's retired-term lifecycle. Do not scope ubiquitous language to this plan set. Keep code identifiers, framework/package names, protocol labels, and temporary architecture wording in the ticket-scoped Spec unless they are independently established domain language. Record bounded-context names, responsibilities, and relationships in `CONTEXT-MAP.md`.
14. Reconcile affected durable model entries and linked diagrams under the model-continuity rules. Record approved changes as `accepted-target` with their Spec/decision reference, preserving current `implemented` facts until verified implementation. Pass rule IDs, owners/enforcement, communication/deployment decisions and relevant System Targets into planning.

## Coverage gate

The Architecture Spec MUST NOT be written while any applicable topic in `references/topics.md` is `PARTIAL` or `UNRESOLVED`.

A target design decision is `SETTLED` when the [grilling](../../../.agents/skills/grilling/SKILL.md) criteria are met by the user's choice or delegation, applicable constraints, and the evidence needed for the decision. Record engineering choices and their rationale under the responsible author. Code-research may settle facts about the current architecture; it does not by itself establish a new product requirement or an undelegated consequential technology choice.

There is no minimum question count. Question count follows unresolved stakeholder decisions; the `grill-with-docs` completion rule permits zero questions when existing choices or explicit delegation settle them.

## Completion Criteria

- Generate `docs/specs/<plan-set-id>/architecture-spec.md` in the format of `references/template.md`.
- For applicable structure, declare independent `.puml` originals and matching SVG targets under `docs/specs/<plan-set-id>/diagrams/architecture/`; use the class and design-state filename/ID/link rules in `references/template.md`.
- Include a class diagram and/or design-state diagram when applicable. If either structure does not apply, state `해당 없음` and provide the reason. Do not duplicate an equivalent Product business-state diagram.
- The Architecture review checks the frozen Architecture Spec against the Product Spec and cited project evidence. Final spec-me diagram stages validate applicable sources, local SVG renders, Markdown SVG links, and content consistency after the Architecture review and decision gates pass; a render failure blocks workflow completion.
- `diagram_creator`만 Architecture 다이어그램 원본·렌더 산출물을 작성한다. `spec-me`는 Architecture Spec Markdown을 작성·수정하고 다이어그램을 검토한다.

설계가 실행 인자·설정·인프라 의존성을 바꾸면 실제 source/CI와 실행 계약을 확인하고 execution.json profile·EXEC의 갱신 책임을 codebase impact에 포함한다. 일반 검증은 프로젝트 기본 CLI로 직접 실행한다. 명시적 최종 사용자 흐름 E2E만 `purpose: "e2e"` profile의 설정 검증과 readiness를 통과해야 한다.
