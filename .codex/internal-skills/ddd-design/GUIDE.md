<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차: [event-storming](../event-storming/GUIDE.md).

# ddd-design

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../static-caller/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

## What it does

`ddd-design` narrows `event-storming` output into aggregates, domain capabilities, bounded-context candidates, consistency, transaction, and integration decisions.

It does not choose packages, modules, persistence, or framework wiring; those choices belong to `codebase-design`.

## Inputs

- Product Spec: 전달된 경로를 사용하며, spec-me 기본 경로는 `docs/specs/<plan-set-id>/product-spec.md`다
- `CONTEXT.md`
- related ADRs
- event-storming output
- Existing affected models, source references, and accepted changes from `CONTEXT-MAP.md` and `docs/architecture/domain-model.md` when present.

Before proposing boundaries, read [model-continuity.md](references/model-continuity.md). It defines existing-model discovery, rule encapsulation, communication/deployment evidence, and the durable model lifecycle. Apply it to affected concepts only; an existing method or function may be the entire design delta.

## Boundary rule

Aggregate boundaries, domain-service boundaries, feature boundaries, and event-storming clusters do not imply bounded-context boundaries.

Treat creation of a new bounded context as a promotion decision. Prefer assigning a capability to an existing bounded context when the language, business-rule ownership, state/data lifecycle, consistency requirements, and change pattern fit that context.

A capability should become a new bounded-context candidate only when there is material evidence that the existing context cannot own it coherently. Evidence may include a distinct ubiquitous language or model, independent business rules or invariants, independent state/data lifecycle, a separate consistency boundary, meaningful change independence, or a required upstream/downstream translation boundary.

Do not create a bounded-context candidate merely because a capability has a distinct name, contains domain logic, owns an aggregate, could expose an API, may be reusable, or is implemented by a technical algorithm.

For every proposed bounded-context candidate, document why modeling it as an internal capability of an existing context would be incorrect or materially harmful.

## Process

1. Read the Product Spec and domain guidance.
2. Review the event-storming result: actors, commands, events, policies, and external systems.
3. Group the flow into aggregate candidates and domain-capability candidates.
4. Assign each capability to an existing bounded context whenever its language, business rules, lifecycle, and consistency requirements fit that context.
5. Treat a new bounded context as an exceptional promotion decision and compare semantic/model independence, business-rule ownership, data/state ownership, consistency and transaction boundaries, change independence, and translation needs before proposing one.
6. Do not infer a bounded context from an aggregate, domain service, event-storming cluster, technical subsystem, algorithm, or named feature alone.
7. Decide consistency, transaction, and integration boundaries only as far as the design needs them.
8. For every proposed bounded context, record why an internal capability boundary in an existing context is insufficient.
9. Ask one question at a time if a stakeholder perspective or material boundary decision is still missing.
10. Hand off structure-level decisions to `codebase-design` without assuming a one-to-one mapping between bounded contexts, code modules, and deployment services.

## Connection

- `event-storming` exposes the business flow and domain shape.
- `ddd-design` classifies aggregates and capabilities, then promotes only sufficiently independent capabilities into bounded-context candidates.
- `codebase-design` turns the settled DDD shape into package, module, and seam decisions using the weakest sufficient code boundary.

## Output shape

- Domain capabilities are classified as part of an existing bounded context, a justified new bounded-context candidate, or an external system.
- Aggregate boundaries are described through entity identity relationships.
- Aggregate boundaries MUST NOT imply bounded-context boundaries.
- Domain behavior is expressed as domain methods or domain services.
- Policies remain design facts that later become unit-testable behavior.
- Every new bounded-context candidate includes the evidence for promotion and why the weaker internal-capability boundary is insufficient.

## Completion

- The design is concrete enough to implement.
- The established vocabulary is not destabilized.
- Bounded-context candidates are supported by ownership and lifecycle evidence rather than feature naming or implementation structure alone.
- Remaining structural questions are deferred to `codebase-design`.
