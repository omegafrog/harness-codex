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

13. `$harness-change-set-pr`

- Commit the target-repository ChangeSet output only after ChangeSet completion succeeds.
- Push the current target-repository branch to `origin`.
- Open or reuse a GitHub PR and record the PR URL.
- Do not report the workflow as complete until the PR creation gate records a PR URL.

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
