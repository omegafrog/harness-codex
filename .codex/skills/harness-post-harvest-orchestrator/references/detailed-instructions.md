# harness-post-harvest-orchestrator Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-post-harvest-orchestrator/SKILL.md`

---

name: harness-post-harvest-orchestrator
description: Run the complete ChangeSet-based harness workflow after harvest has produced requirements and use cases. Use to orchestrate ChangeSet creation, affected use-case selection, use-case scoped event storming, DDD design, technical decisions, E2E goal approval, use-case planning, execution, verification, remediation loops, project wiki updates, and ChangeSet completion.

---

# Harness Post-Harvest Orchestrator

## Agent Context Bootstrap

Before post-harvest orchestration in a new target repository, ensure repo-local
agent context exists:

```bash
python3 -m harness_codex agent-context init --description "<repo description>"
```

If an existing unmarked `AGENTS.md` is present, the bootstrap preserves it and
stores harness context under `docs/agent/`. During orchestration, read the
smallest relevant `docs/agent/` file and avoid broad context dumps.

## Purpose

Run the ChangeSet-based post-harvest orchestration flow for harness engineering.

This skill assumes harvest has already produced the initial product/design inputs. It does not replace the specialist skills. It invokes them in order, validates each handoff artifact, and routes each affected use case through its own planning, execution, verification, and remediation loop.

## Harvest Assumption

Harvest is considered complete when these files exist and are usable:

- `docs/design/요구사항.md`
- `docs/design/유스케이스.md`

If either file is missing, stop and explain that harvest must run first. Do not invent requirements or use cases.

## Orchestration Flow

Run these stages in order:

1. **Capture implementation intent**
   - Input: initial implementation prompt, change request, and harvested requirements/use cases.
   - Output gate: explicit summary of the requested document/code delta.
   - If the implementation intent is unclear, return to the harvester/user goal gate before creating downstream artifacts.
2. **Create ChangeSet**
   - Output gate: `docs/changes/active/<CHG-ID>.md`
   - The ChangeSet must define before/after intent, changed documents, affected use cases, E2E goal changes, and planner input scope.
   - Do not continue without an active ChangeSet.
3. **Identify affected use cases**
   - Input: `docs/changes/active/<CHG-ID>.md`, `docs/design/요구사항.md`, and `docs/design/유스케이스.md`.
   - Output gate: explicit affected UC list recorded in the ChangeSet.
   - Every affected UC must have or receive a `docs/use-cases/<UC-ID>/` slice.
4. **Create or update use-case slices**
   - Output gate for each affected UC:
     - `docs/use-cases/<UC-ID>/use-case.md`
     - `docs/use-cases/<UC-ID>/e2e-goal.md`
   - The E2E goal must include observable Given/When/Then success criteria and the repository verification command expectation.
5. `$harness-event-storming` per affected UC
   - Input: `docs/use-cases/<UC-ID>/use-case.md`, `docs/use-cases/<UC-ID>/e2e-goal.md`, and `docs/changes/active/<CHG-ID>.md`
   - Output gate: `docs/use-cases/<UC-ID>/event-storming.md`
   - `docs/design/이벤트 스토밍.md` may remain a summary/index, but the executor-facing source is the UC slice.
6. `$harness-ddd-design` per affected UC
   - Input: UC slice, UC event storming, ChangeSet, and existing canonical design docs
   - Runs as a staged approval flow. After each stage output, stop and wait for
     explicit user confirmation before continuing to the next DDD stage.
   - Design constraint gate:
     - The design must preserve bounded-context boundaries.
     - The design must state aggregate ownership and state-change rules.
     - The design must state application-service orchestration boundaries.
     - The design must identify external ports/adapters without choosing implementation technology unless already decided.
     - The design must not generate code, package skeletons, Gradle files, tests, or implementation tasks.
   - Output gate for each affected UC:
     - `docs/use-cases/<UC-ID>/ddd-design.md`
   - Canonical `docs/design/details/*.md` may be updated only when the specialist skill owns the change and the ChangeSet allows it.
7. `$harness-technical-decisions` per affected UC
   - Input: UC slice, UC DDD design, ChangeSet, and existing technical decisions
   - Output gate:
     - `docs/use-cases/<UC-ID>/technical-decisions.md`
     - `docs/design/기술결정.md` if shared decisions changed
   - Decide detailed implementation strategies after DDD design, including polling/push,
     circuit breaker, retry/backoff, outbox/inbox, transaction details, cache policy,
     messaging failure handling, observability, and integration testing strategy.
   - If foundational technology choices are missing, ask the user before proceeding.
   - Do not start planner while implementation-affecting technical decisions remain unresolved.
8. **Final user approval gate**
   - Show the user the ChangeSet summary, affected UC list, UC E2E goals, UC DDD design, and technical-decision summary.
   - Ask for explicit approval to proceed to use-case implementation planning.
   - Do not run `$harness-code-planner` for any UC until the user explicitly approves both the implementation scope and each affected UC E2E goal.
9. `$harness-code-planner` per affected UC
   - Input: `docs/changes/active/<CHG-ID>.md`, `docs/use-cases/<UC-ID>/**`, `ARCHITECTURE.md`, `docs/design/기술결정.md`, and `.codex/repository-settings.md`
   - Output gate: `docs/plans/active/<UC-ID>/plan.md`
   - The planner owns its own `ARCHITECTURE.md` preflight. If `ARCHITECTURE.md` is missing, the planner must explicitly invoke `$spring-package-structure`.
10. `$harness-plan-executor` per affected UC

- Input: `docs/plans/active/<UC-ID>/plan.md`, `docs/use-cases/<UC-ID>/e2e-goal.md`, `docs/use-cases/<UC-ID>/**`, `docs/changes/active/<CHG-ID>.md`, `ARCHITECTURE.md`, `.codex/repository-settings.md`, and `.codex/test-gate.yaml`
- Execution is mandatory once the UC active plan gate succeeds.
- It must not implement code directly. It delegates code implementation to the
     `implementation_executor` agent, runs UC final verification, adds remediation plan tasks
     only for `IMPLEMENTATION_FAILURE`, and repeats until the UC passes or a blocker is documented.
- Completion gate:
  - every checkbox in `docs/plans/active/<UC-ID>/plan.md` is complete, including remediation iterations when needed
  - required build/test/E2E/runtime-server/static-analysis verification passes according to the UC plan, UC E2E goal, and `.codex/test-gate.yaml`
  - completed plans are moved according to `$harness-plan-executor` rules

11. `$harness-project-wiki`

- Input: active ChangeSet, completed affected work-item plans, verification evidence, affected slices, architecture, implementation, tests, and existing wiki pages.
- Output gate:
  - `docs/wiki/index.md`
  - `mkdocs.yml`
  - `docs/wiki/requirements.txt`
  - `scripts/build-wiki.sh`
  - `scripts/serve-wiki.sh`
- Create the initial project wiki when absent. Otherwise update existing pages incrementally.
- Use MkDocs Material and require `./harness run wiki build` strict validation.
- Document only verified current behavior. Do not copy planned, rejected, failed, secret, or raw-log content.
- A missing or failed wiki output blocks ChangeSet completion.

12. **Complete ChangeSet**

- Move `docs/changes/active/<CHG-ID>.md` to `docs/changes/completed/<CHG-ID>.md` only after every affected UC passes, each UC plan has been completed, and the project wiki update succeeds.
- Do not complete the ChangeSet while any affected UC is blocked, unplanned, active, or failed.

The orchestration pauses after technical decisions until the user explicitly approves the ChangeSet,
affected UC list, and each UC E2E goal. After approval, it does not stop at planning. It must invoke
`$harness-plan-executor` for each `docs/plans/active/<UC-ID>/plan.md` created by the planner.

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

After `$harness-ddd-design`, run `$harness-technical-decisions` for the affected UC before planning.

This gate owns detailed technical choices that should not be forced during requirements elicitation:

- polling vs push/webhook/scheduler
- circuit breaker, retry/backoff, timeout, bulkhead
- outbox/inbox, idempotency, message ordering, duplicate handling
- transaction propagation, eventual consistency, compensation
- cache TTL, invalidation, Redis usage details
- messaging topic/queue/channel and consumer failure policy
- logging, metrics, tracing, audit fields
- integration/contract/container test strategy

If `docs/use-cases/<UC-ID>/technical-decisions.md` or `docs/design/기술결정.md` has unresolved items
that affect implementation scope, stop and ask the user. Do not send unresolved implementation
choices to the planner.

## Failure Routing

Classify every UC verification failure before choosing the next stage:

- `IMPLEMENTATION_FAILURE`: code, tests, configuration, or static analysis fails inside the approved UC plan and ChangeSet scope. Return only this type to the UC plan remediation loop.
- `UNCLEAR_E2E_GOAL`: the UC E2E goal is missing, ambiguous, untestable, or not user-approved. Return to the harvester/user goal gate.
- `DOCUMENT_DELTA_CONFLICT`: the ChangeSet, UC docs, E2E goal, or plan disagree about scope or intended behavior. Return to ChangeSet revision.
- `UPSTREAM_DESIGN_CONFLICT`: event storming, DDD design, technical decisions, architecture, or repository structure must change before implementation can proceed. Return to the relevant event storming, DDD, technical-decision, or architecture stage.
- `ENVIRONMENT_BLOCKER`: permissions, network, Playwright browser installation, credentials, unavailable external services, or host tooling prevent verification. Record the blocker and stop.

Only `IMPLEMENTATION_FAILURE` may add remediation tasks to `docs/plans/active/<UC-ID>/plan.md` and
repeat `$harness-plan-executor`. All other failure types must leave the executor loop and report the
stage that owns the correction.

## Execution Rules

- Announce each specialist skill before invoking it.
- Do not perform a specialist skill's work directly from this orchestrator.
- If a specialist skill says to delegate to its configured agent, let that skill perform the delegation.
- During `$harness-ddd-design`, respect its staged approval gates. Do not continue to the
  next DDD stage, technical decisions, planner, or executor until the user explicitly approves
  the current DDD stage and all required DDD outputs exist.
- Do not read `ticketon-ddd블로그` at runtime.
- Do not skip stages unless the user explicitly asks to resume from an existing gate and the gate artifact exists.
- Do not overwrite or delete existing design artifacts unless the invoked specialist skill owns that file and updates it.
- Preserve user changes. If unexpected user edits affect a gate, work with them rather than reverting.
- Do not run `$harness-code-planner` until the active ChangeSet exists, affected UCs are identified,
  every targeted UC E2E goal exists and is approved, implementation-blocking technical decisions are
  resolved, and the user has explicitly approved planning.
- Do not run `$harness-plan-executor` for a UC until `docs/plans/active/<UC-ID>/plan.md` exists and
  references the active ChangeSet and approved UC E2E goal.
- Do not run `$harness-project-wiki` until every affected work-item plan is completed and verified.
- Do not complete `docs/changes/active/<CHG-ID>.md` until every affected UC plan is completed and
  the MkDocs wiki has been created or updated and its strict build passes.

## Resume Rules

When artifacts already exist:

- If `docs/changes/active/<CHG-ID>.md` exists and the user did not ask to regenerate it, treat ChangeSet creation as complete and validate the affected UC list before continuing.
- If `docs/use-cases/<UC-ID>/event-storming.md` exists for an affected UC and the user did not ask to regenerate it, treat that UC event-storming stage as complete.
- If `docs/use-cases/<UC-ID>/ddd-design.md` exists for an affected UC and the user did not ask to regenerate UC DDD design, treat that UC DDD stage as complete.
- If `docs/use-cases/<UC-ID>/technical-decisions.md` exists for an affected UC and the user did not ask to regenerate technical decisions, treat that UC technical-decision stage as complete.
- If `docs/use-cases/<UC-ID>/e2e-goal.md` exists for every affected UC, still require user approval before planning unless approval is already recorded.
- If `docs/plans/active/<UC-ID>/plan.md` exists for an affected UC and the user did not ask to regenerate that UC plan, treat that UC planning stage as complete.
- If `docs/plans/completed/<UC-ID>/plan.md` exists for an affected UC, treat that UC as complete unless the active ChangeSet includes a newer delta for the same UC.
- If `docs/wiki/index.md` contains a Change History entry for the active ChangeSet,
  `mkdocs.yml` exists, `./harness run wiki build` passes, and no affected artifact is newer,
  treat the wiki stage as complete.
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

- `$harness-code-planner` must include static-analysis setup or verification tasks in each UC `plan.md`.
- `$harness-code-planner` must include decisions from the UC technical-decision slice and `docs/design/기술결정.md` in each UC `plan.md`.
- `$harness-plan-executor` must invoke `$ddd-architecture-linter` when the targeted UC plan reaches static-analysis setup or verification.
- `$harness-plan-executor` must delegate implementation to `implementation_executor` and may only update the targeted UC `plan.md` for orchestration, verification evidence, and `IMPLEMENTATION_FAILURE` remediation tasks.
- If Semgrep is missing during linter execution, `$ddd-architecture-linter` must request approval and attempt installation according to its own instructions.

## User-Facing Result

After the orchestration completes or stops, report:

- Completed stages.
- Current gate artifact path.
- Active ChangeSet ID and affected UC list.
- Whether final user approval was received before planning.
- Per-UC planning, execution, verification, and remediation result.
- Project wiki path and update result.
- Any failed gate and exact missing file.
- Next command or skill the user should run, if the flow stopped intentionally.
