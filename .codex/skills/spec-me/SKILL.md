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
2. When the Product diagram gate applies, call `multi_agent_v1.spawn_agent` with `agent_type="diagram_creator"`, `fork_context: false`, the configured `agents.default_model`, and the settled Product requirements plus exact ticket scope; wait for the lightweight agent result, then review its artifacts in the main context.
3. Do not advance until the Product Spec coverage gate and applicable Product 다이어그램 완료 게이트 have passed and `docs/specs/<ticket-id>/product-spec.md` exists.
4. Run `architecture-spec` using the completed Product Spec.
5. Use `event-storming`, `ddd-design`, and `codebase-design` as needed inside the architecture step.
6. When the Architecture diagram gate applies, call `multi_agent_v1.spawn_agent` with `agent_type="diagram_creator"`, `fork_context: false`, the configured `agents.default_model`, and the settled Architecture design plus exact ticket scope; wait for the lightweight agent result, then review its artifacts in the main context.
7. Do not advance until the Architecture Spec coverage gate and applicable Architecture 다이어그램 완료 게이트 have passed and `docs/specs/<ticket-id>/architecture-spec.md` exists.
8. Stop after Product Spec and Architecture Spec are complete.
9. Recommend `to-ticket`, but do not call it automatically.

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
- Each stage's diagram completion gate requires the applicable `.puml` original, successful local render through the existing renderer, non-empty SVG, Markdown SVG link, ID traceability, and Spec-content consistency review. A missing or failed render blocks stage completion.
- 다이어그램 완료 게이트의 원본은 `.puml` 파일이며, 렌더된 SVG와 Markdown 링크까지 확인해야 한다.
- 원본과 렌더 산출물의 내용 일치 검토가 끝나야 단계 완료로 판정한다.
- 렌더 실패는 해당 Spec 단계 완료를 막는다.
- 다이어그램 생성·렌더링은 경량 `diagram_creator` 서브에이전트가 실행하고, `spec-me`가 산출물·내용 일치를 검토한다.
- 다이어그램 작업을 상위 에이전트가 직접 수행하지 않는다. `diagram_creator` 결과가 실패하면 원인·파일·복구 방법을 보고하고 해당 Spec 게이트를 멈춘다.
- Apply diagrams conditionally: no flow change means no forced Product flow diagrams; Product never gets class diagrams; duplicate business/design state diagrams are not created.

## Rules

- Product Spec does not inspect source or test code.
- Architecture Spec does inspect current code and test structure.
- Current implementation may settle descriptive facts but does not automatically settle desired product behavior or a material target architecture decision.
- `CONTEXT.md` is glossary only.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.
