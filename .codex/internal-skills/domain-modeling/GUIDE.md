<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [ddd-design](../ddd-design/GUIDE.md) · [sync-contracts](../sync-contracts/GUIDE.md).

# domain-modeling

## What it does

`domain-modeling` sharpens ubiquitous language, stress-tests relationships, and records durable decisions.

Use it proactively whenever affected model meaning, ownership, identity or lifecycle changes. Detect vocabulary drift even without a rename request or a pre-existing retirement record; propose and resolve the terminology consequence with the model decision rather than preserving old names by default.

`CONTEXT.md` is a glossary and nothing else: no implementation details, no spec, no scratch pad. When a real decision crystallizes, let the model decide whether to record it in an ADR.

## Durable vocabulary placement

Read [language-lifecycle.md](references/language-lifecycle.md) when choosing, renaming or retiring terms. Resolve current canonical and retired/replacement records before using historical Specs or code names. Keep retired terms as scoped tombstones, not active aliases; preserve only evidenced compatibility identifiers at their boundary.

Keep affected model ownership and lifecycle under [model-continuity.md](../ddd-design/references/model-continuity.md). `docs/architecture/domain-model.md` indexes implemented/accepted aggregate models, rule enforcement, communication and deployment evidence; `CONTEXT-MAP.md` links it. Reuse canonical diagrams rather than copying their content. The model index is architecture documentation, never a task/status board or a second glossary.

When a Product Spec or Architecture Spec defines terminology, classify each term before the stage is complete:

- Project-wide canonical terms used across contexts belong in `CONTEXT.md`.
- Context-specific terms belong in `CONTEXT.md` with their bounded-context scope stated, or in a dedicated context glossary when one exists.
- Bounded-context names, responsibilities, and relationships belong in `CONTEXT-MAP.md`, not in the glossary.
- Spec-only temporary wording remains in the ticket-scoped Spec.

The Spec terminology table is evidence for this classification, not a substitute for updating the durable document. Add or correct the durable entry when the term is settled, preserve the Spec as the historical source, and record the source Spec or decision in the glossary row. Do not copy every descriptive noun into `CONTEXT.md`.

## When to reach for it

Type `/domain-modeling`, or let a higher-level flow reach for it automatically, when you are pinning down terminology, resolving an overloaded word, or recording an architectural decision.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.
