---
name: harness-post-harvest-orchestrator
description: Run the complete harness workflow after harvest has produced requirements and use cases. Use to orchestrate event storming, DDD design, post-DDD technical decisions, final user approval, implementation planning, and mandatory plan execution by explicitly invoking the existing harness skills in order.
---

# Harness Post-Harvest Orchestrator

## Purpose

Run the single post-harvest orchestration flow for harness engineering.

This skill assumes harvest has already produced the initial product/design inputs. It does not replace the specialist skills. It invokes them in order, validates each handoff artifact, and stops on the first failed gate.

## Harvest Assumption

Harvest is considered complete when these files exist and are usable:

- `docs/design/요구사항.md`
- `docs/design/유스케이스.md`

If either file is missing, stop and explain that harvest must run first. Do not invent requirements or use cases.

## Orchestration Flow

Run these stages in order:

1. `$harness-event-storming`
   - Input: `docs/design/요구사항.md`, `docs/design/유스케이스.md`
   - Output gate: `docs/design/이벤트 스토밍.md`
2. `$harness-ddd-design`
   - Input: requirements, use cases, event storming
   - Design constraint gate:
     - The design must preserve bounded-context boundaries.
     - The design must state aggregate ownership and state-change rules.
     - The design must state application-service orchestration boundaries.
     - The design must identify external ports/adapters without choosing implementation technology unless already decided.
     - The design must not generate code, package skeletons, Gradle files, tests, or implementation tasks.
   - Output gate:
     - `docs/design/details/index.md`
     - `docs/design/details/도메인모델.md`
     - `docs/design/details/어그리거트.md`
     - `docs/design/details/애플리케이션서비스.md`
     - `docs/design/details/바운디드컨텍스트.md`
3. `$harness-technical-decisions`
   - Input: requirements, use cases, event storming, and all DDD detail docs
   - Output gate: `docs/design/기술결정.md`
   - Decide detailed implementation strategies after DDD design, including polling/push,
     circuit breaker, retry/backoff, outbox/inbox, transaction details, cache policy,
     messaging failure handling, observability, and integration testing strategy.
   - If foundational technology choices are missing, ask the user before proceeding.
   - Do not start planner while implementation-affecting technical decisions remain unresolved.
4. **Final user approval gate**
   - Show the user the DDD design and `docs/design/기술결정.md` summary.
   - Ask for explicit approval to proceed to implementation planning.
   - Do not run `$harness-code-planner` until the user explicitly approves.
5. `$harness-code-planner`
   - Input: design docs, `docs/design/기술결정.md`, and `ARCHITECTURE.md`
   - Output gate: `docs/plans/active/plan.md`
   - The planner owns its own `ARCHITECTURE.md` preflight. If `ARCHITECTURE.md` is missing, the planner must explicitly invoke `$spring-package-structure`.
6. `$harness-plan-executor`
   - Input: `docs/plans/active/plan.md`, `ARCHITECTURE.md`, and `docs/design/**`
   - Execution is mandatory once the active plan gate succeeds.
   - Completion gate:
     - every active plan checkbox is complete, or execution stops on a documented blocker
     - required build/test/static-analysis verification is recorded according to the active plan
     - completed plans are moved according to `$harness-plan-executor` rules

The orchestration pauses after technical decisions until the user explicitly approves planning.
After approval, it does not stop at planning. It must invoke `$harness-plan-executor` after
`docs/plans/active/plan.md` is created.

## Design Constraints

During `$harness-ddd-design`, ensure the design artifacts capture constraints that downstream planning and implementation must obey:

- Domain model constraints: entities and value objects own their validation rules; setters and direct state mutation are forbidden.
- Aggregate constraints: state changes must go through aggregate root behavior methods; atomic consistency boundaries must be explicit.
- Application service constraints: services orchestrate use cases and ports only; they must not contain domain rules or infrastructure implementation logic.
- Bounded-context constraints: cross-BC communication must use IDs, summaries, public APIs, ports, or clients, not another BC's internal model.
- Infrastructure constraints: persistence, local storage, external clients, messaging, and logging belong behind ports/adapters.
- Transaction/communication constraints: synchronous calls, compensation, retries, idempotency, and outbox/inbox decisions must be documented when they affect the design.
- Open decisions: unresolved business or technology decisions that affect domain structure must stop the design stage rather than being guessed.

## Technical Decision Gate

After `$harness-ddd-design`, run `$harness-technical-decisions` before planning.

This gate owns detailed technical choices that should not be forced during requirements elicitation:

- polling vs push/webhook/scheduler
- circuit breaker, retry/backoff, timeout, bulkhead
- outbox/inbox, idempotency, message ordering, duplicate handling
- transaction propagation, eventual consistency, compensation
- cache TTL, invalidation, Redis usage details
- messaging topic/queue/channel and consumer failure policy
- logging, metrics, tracing, audit fields
- integration/contract/container test strategy

If `docs/design/기술결정.md` has unresolved items that affect implementation scope, stop and ask
the user. Do not send unresolved implementation choices to the planner.

## Execution Rules

- Announce each specialist skill before invoking it.
- Do not perform a specialist skill's work directly from this orchestrator.
- If a specialist skill says to delegate to its configured agent, let that skill perform the delegation.
- Do not read `ticketon-ddd블로그` at runtime.
- Do not skip stages unless the user explicitly asks to resume from an existing gate and the gate artifact exists.
- Do not overwrite or delete existing design artifacts unless the invoked specialist skill owns that file and updates it.
- Preserve user changes. If unexpected user edits affect a gate, work with them rather than reverting.
- Do not run `$harness-code-planner` until `docs/design/기술결정.md` exists, implementation-blocking
  technical decisions are resolved, and the user has explicitly approved planning.

## Resume Rules

When artifacts already exist:

- If `docs/design/이벤트 스토밍.md` exists and the user did not ask to regenerate it, treat stage 1 as complete.
- If all `docs/design/details/*.md` outputs exist and the user did not ask to regenerate DDD design, treat stage 2 as complete.
- If `docs/design/기술결정.md` exists and the user did not ask to regenerate technical decisions, treat stage 3 as complete, but still require explicit user approval before planning unless approval is already recorded.
- If `docs/plans/active/plan.md` exists and the user did not ask to regenerate the plan, treat stage 5 as complete.
- If the user asks to regenerate a stage, regenerate that stage and every downstream stage because downstream artifacts may be stale.

## Gate Checks

After each stage, verify only the expected output files exist and are non-empty.

If a gate fails:

- Stop immediately.
- Report which stage failed.
- Report the missing or empty files.
- Do not continue to downstream stages.

## Static Analysis Policy

This orchestrator does not install linting directly.

- `$harness-code-planner` must include static-analysis setup or verification tasks in `plan.md`.
- `$harness-code-planner` must include decisions from `docs/design/기술결정.md` in `plan.md`.
- `$harness-plan-executor` must invoke `$ddd-architecture-linter` when the active plan reaches static-analysis setup or verification.
- If Semgrep is missing during linter execution, `$ddd-architecture-linter` must request approval and attempt installation according to its own instructions.

## User-Facing Result

After the orchestration completes or stops, report:

- Completed stages.
- Current gate artifact path.
- Whether final user approval was received before planning.
- Implementation execution result.
- Any failed gate and exact missing file.
- Next command or skill the user should run, if the flow stopped intentionally.
