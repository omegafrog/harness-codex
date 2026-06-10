# harness-plan-executor Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-plan-executor/SKILL.md`

---
name: harness-plan-executor
description: Orchestrate use-case scoped execution of docs/plans/active/<UC-ID>/plan.md for harness engineering by delegating implementation to the implementation_executor agent, verifying against the use-case E2E goal and test gate, adding remediation tasks only for implementation failures, and moving completed use-case plans to docs/plans/completed/<UC-ID>/plan.md.
---

# Harness Plan Executor

## Purpose

Orchestrate execution of one use-case scoped active plan in `docs/plans/active/<UC-ID>/plan.md`.

This skill does not implement product code directly. It delegates implementation to
`.codex/agents/implementation_executor.toml`, verifies the implemented behavior against
`docs/use-cases/<UC-ID>/e2e-goal.md` and the repository test gate, records the
implementation-specific test suite and proof in `docs/plans/active/<UC-ID>/verification.md`,
updates only that UC plan with remediation tasks after implementation failures, and repeats the
implementation/verification loop until the use case passes or a real blocker is documented.

## Required Inputs

- `docs/plans/active/<UC-ID>/plan.md`
- `docs/plans/active/<UC-ID>/verification.md` when present
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- `docs/use-cases/<UC-ID>/**`
- `docs/changes/active/<CHG-ID>.md`
- `ARCHITECTURE.md`
- `.codex/repository-settings.md`
- `.codex/test-gate.yaml`
- Relevant design or technical decision docs referenced by the UC plan, UC docs, or ChangeSet

If the UC ID or ChangeSet ID is not explicit in the user request, infer it from the active plan
path, the plan front matter, or the ChangeSet. If more than one active UC plan is present and no
target is clear, stop and ask which UC plan to execute.

If the targeted UC plan, UC E2E goal, ChangeSet, `ARCHITECTURE.md`, repository settings, or test
gate is missing, stop. Do not invent a plan, E2E goal, ChangeSet, architecture, or gate.

## Required Agent

- agent id: `implementation_executor`
- config: `.codex/agents/implementation_executor.toml`

If the implementation executor agent cannot be found or invoked, stop. Do not implement code
from this skill as a fallback.

## Source Priority

Use sources in this order:

1. `docs/plans/active/<UC-ID>/plan.md`
2. `docs/use-cases/<UC-ID>/e2e-goal.md`
3. `docs/changes/active/<CHG-ID>.md`
4. `docs/use-cases/<UC-ID>/**`
5. `.codex/test-gate.yaml`
6. `ARCHITECTURE.md`
7. Relevant `docs/design/**` and technical decision docs
8. Existing repository code and build configuration

If sources conflict, follow the UC plan for task order, the ChangeSet for scope boundary, the UC
E2E goal for business acceptance criteria, and `ARCHITECTURE.md` for structural constraints.
Record implementation-specific test suite details, fixtures, request/response examples, UI steps,
commands, and actual pass/fail evidence in `docs/plans/active/<UC-ID>/verification.md` or plan
section `10. 검증 결과`, not in the approved E2E goal. Record conflicts in the UC plan under
`검증 실패` and classify them before continuing.

Do not read `ticketon-ddd블로그` at runtime.

## Hard Scope Rules

- Do not implement code directly from this skill.
- Delegate product code, tests, build/config edits, and focused task verification to `implementation_executor`.
- Do not add features, domain rules, integrations, UI flows, infrastructure, or dependencies outside the targeted UC plan and ChangeSet.
- Do not change requirements, UC docs, ChangeSet, architecture, or technical decision documents unless the targeted UC plan explicitly requires it.
- Do not mark implementation checkboxes complete yourself unless you are recording results already completed by `implementation_executor`.
- Do not move `docs/plans/active/<UC-ID>/plan.md` to `docs/plans/completed/<UC-ID>/plan.md` until every checkbox is checked, the UC E2E goal is satisfied, and build, tests, runtime server verification, and static analysis are recorded as successful, unless runtime server verification is explicitly marked not applicable with a reason.
- Do not execute or complete other active UC plans while handling the targeted UC.
- Preserve user changes. Never revert unrelated work.

## Execution Workflow

1. Resolve the targeted UC ID and ChangeSet ID.
2. Read `docs/plans/active/<UC-ID>/plan.md`, `docs/use-cases/<UC-ID>/e2e-goal.md`, the related `docs/use-cases/<UC-ID>/**` files, `docs/changes/active/<CHG-ID>.md`, `ARCHITECTURE.md`, repository settings, and `.codex/test-gate.yaml`.
3. Confirm the UC plan is inside the ChangeSet scope and names the UC E2E goal as its completion target. If it does not, classify the mismatch before execution.
4. Identify unchecked implementation/test/setup tasks in the targeted UC plan only.
5. Invoke `implementation_executor` to execute the unchecked tasks. The executor owns code edits, test edits, build/config edits required by the UC plan, focused verification, and checkbox updates.
6. When `implementation_executor` stops, inspect the targeted UC plan and the executor report. If the executor changed a UI/runtime/dashboard boundary, require a `qa_inspector` result before accepting the task as complete. A missing QA Inspector result or `Review Status: rejected` is an implementation-level failure unless the report names a non-implementation blocker.
7. If unchecked tasks remain because of a blocker, report the blocker and stop.
8. If all tasks are checked, run final verification from the UC plan section `8. 검증 방법`, the UC E2E goal, and `.codex/test-gate.yaml`, including Playwright MCP browser verification from the end user's perspective only when implemented behavior has a browser-accessible web UI, otherwise using the existing API/runtime verification path, and runtime server verification through `harness run app` after a successful build when the plan defines a runnable application.
9. Record final verification results in the UC plan section `10. 검증 결과` and record concrete implementation proof in `docs/plans/active/<UC-ID>/verification.md`. The verification artifact should include the implementation-specific test suite, test files/cases, fixtures, API request/response examples when applicable, UI steps when applicable, commands, and actual pass/fail evidence.
10. If final verification passes, move `docs/plans/active/<UC-ID>/plan.md` to `docs/plans/completed/<UC-ID>/plan.md`.
11. If final verification fails, classify the failure before adding remediation tasks. Add remediation only for implementation-level failures. Stop and report to the user for unclear E2E goals, document deltas, upstream design/architecture/technical-decision failures, and environment blockers.

## Verification Failure Loop

When final verification fails after all planned tasks for the targeted UC were executed:

1. Record the failed command, exit result, and concise failure evidence under `11. 검증 실패`.
2. Classify the failure:
   - **IMPLEMENTATION_FAILURE**: code does not match the approved UC plan, tests expose a missing branch, mapping/configuration is incomplete, static analysis finds a fixable package/dependency violation, or a verification command fails because of an implementation mistake inside the UC plan and ChangeSet scope.
   - **UNCLEAR_E2E_GOAL**: `docs/use-cases/<UC-ID>/e2e-goal.md` is missing, ambiguous, untestable, or lacks enough observable success criteria to verify completion.
   - **DOCUMENT_DELTA_CONFLICT**: the UC plan, UC docs, E2E goal, and active ChangeSet disagree about the intended document delta or implementation scope.
   - **UPSTREAM_DESIGN_CONFLICT**: requirements, use cases, event storming, DDD design, technical decisions, or `ARCHITECTURE.md` are inconsistent, incomplete, impossible to implement safely, or contradicted by tests/static analysis in a way that requires changing approved design artifacts.
   - **ENVIRONMENT_BLOCKER**: permissions, unavailable external services, missing local tools that cannot be installed in this run, network, credentials, or host constraints prevent verification.
3. For `UNCLEAR_E2E_GOAL`, do not add remediation tasks. Record the blocker and return to the harvester/user goal gate.
4. For `DOCUMENT_DELTA_CONFLICT`, do not add remediation tasks. Record the blocker and return to ChangeSet revision.
5. For `UPSTREAM_DESIGN_CONFLICT`, do not add remediation tasks. Add a blocker section to the targeted UC plan and stop:

```markdown
## 12. 상위 단계 재검토 필요
- 실패 유형: UNCLEAR_E2E_GOAL | DOCUMENT_DELTA_CONFLICT | UPSTREAM_DESIGN_CONFLICT
- 실패 증거:
- 왜 UC plan executor에서 고칠 수 없는가:
- 되돌아갈 단계:
- 사용자 확인 필요:
```

6. Report the blocker to the user and name the stage to revisit, such as the harvester/user goal gate, ChangeSet revision, `$harness-event-storming`, `$harness-ddd-design`, `$harness-technical-decisions`, or `$harness-code-planner`.
7. For `ENVIRONMENT_BLOCKER`, do not add code-remediation tasks. Record the blocker and ask the user for the missing permission/tool/service.
8. Only for `IMPLEMENTATION_FAILURE`, add a new unchecked remediation section to the targeted UC plan, for example:

```markdown
## 12. 재실행 계획 N
- [ ] 실패 원인을 수정한다: <specific failing test/build/static-analysis issue>
- [ ] 수정 범위를 검증하는 테스트 또는 정적 분석을 보강한다.
- [ ] 실패했던 최종 검증 명령을 다시 실행한다.
```

9. Keep the plan in `docs/plans/active/<UC-ID>/plan.md`.
10. Invoke `implementation_executor` again to execute only the newly added unchecked remediation tasks for the targeted UC.
11. Re-run final verification for the targeted UC.
12. Repeat until the UC E2E goal, build, tests, runtime server verification, and static analysis all pass or a non-implementation blocker is found.

## Non-Implementation Failure Signals

Treat a final verification failure as non-implementation failure, not implementation remediation,
when any of these are true:

- The UC E2E goal is absent, ambiguous, or not testable.
- The active ChangeSet does not include this UC or contradicts the UC plan.
- The UC docs and ChangeSet describe different intended behavior or document deltas.
- The approved requirements or use cases contradict the DDD design.
- Event storming lacks a command/event/policy needed to implement or test the behavior.
- Aggregate boundaries make required consistency impossible without changing DDD design.
- Application service orchestration requires a port, transaction boundary, or policy absent from design docs.
- Technical decisions are missing or contradictory, such as persistence, messaging, cache, retry, idempotency, or transaction strategy.
- ARCHITECTURE.md package/module rules prevent the planned implementation shape.
- The failing test reveals an unapproved business rule or a different expected user-visible behavior.
- Static analysis exposes a dependency direction that cannot be fixed without changing module boundaries.
- Fixing the failure would require changing `docs/design/**`, `ARCHITECTURE.md`, or the approved technical decisions rather than only code/tests/config inside the existing plan.

Stop the loop only when:

- final verification passes for the targeted UC, or
- the failure is an unclear E2E goal, document delta conflict, upstream design/requirements/architecture/technical-decision issue that must return to the user, or
- the failure is an environment/permission/external-service blocker that cannot be fixed in the repository, or
- the same failure repeats with no new plausible repository change; document it as a blocker instead of looping blindly.

## Implementation Constraints

- Follow the module and package boundaries in `ARCHITECTURE.md`.
- Keep `spring-boot-app` limited to bootstrapping, global configuration, and wiring.
- Put business rules in the owning domain model, aggregate, or domain service.
- Put orchestration in application services.
- Put technology details in infrastructure adapters behind ports.
- Expose cross-module contracts only through another module's `api` package.
- Do not create root-level technical packages such as `controller`, `service`, `repository`, `entity`, or `dto`.

## Test Expectations

Use the test scope in the targeted UC plan, the UC E2E goal, and `.codex/test-gate.yaml`.
Treat `docs/use-cases/<UC-ID>/e2e-goal.md` as the business acceptance contract approved before
implementation. Do not add implementation-specific test suite details to it after approval. Write
technical test details and proof to `docs/plans/active/<UC-ID>/verification.md` or the UC plan
verification result instead.

- Domain/Aggregate/VO tests verify invariants, state transitions, invalid values, and boundary conditions.
- Domain service tests verify domain calculations and decisions.
- Application service tests verify orchestration, port calls, save order, and failure/fallback paths.
- Infrastructure tests verify adapters, serialization, persistence/local-storage mapping, and Spring wiring.
- Communication/transaction tests verify cross-BC call order, state consistency, duplicate prevention, and save/fallback behavior.

Do not use application service tests to re-test aggregate internals.

## Verification

Follow the targeted UC plan section `8. 검증 방법`, the UC E2E goal, and `.codex/test-gate.yaml`.

For UI/runtime/dashboard boundary changes, final verification must include the QA Inspector evidence produced immediately after the boundary edit. Treat endpoint/consumer JSON shape, frontend/backend route, session-stage display, dashboard projection, and artifact-link mismatches as implementation failures when they are inside the active ChangeSet scope.

Typical final commands are:

```bash
./gradlew build
./gradlew test
./gradlew e2eTest
./gradlew architectureRules
semgrep --config .semgrep/ddd-architecture.yml .
```

If static-analysis tooling is not installed yet, implement the setup task described in the targeted
UC plan before final verification.

After build succeeds, start the application server if the targeted UC plan defines runtime server
verification. Use `harness run app` to exercise the versioned `scripts/run-app.sh` launcher and its
code-defined local infrastructure. Direct commands such as `./gradlew bootRun` or
`docker compose up` may diagnose failures but do not replace launcher verification. Wait until the
server is ready, and record the observed result in section `10. 검증 결과` and
`docs/plans/active/<UC-ID>/verification.md`. When implemented behavior
includes a UI and a browser-accessible frontend can be started, use Playwright MCP to perform the
approved Given/When/Then flow through the visible UI as an end user. Verify that frontend-to-backend
browser requests succeed under the local origin arrangement; if origins differ, confirm the planned
proxy or CORS/preflight behavior for actual request methods and headers. Otherwise, use the existing
API/runtime checks and record why browser verification was not applicable. Stop servers before continuing. If the server
cannot start because of environment limits, credentials, external services, or a port conflict,
record the exact blocker under `11. 검증 실패` and treat it as an environment blocker unless a
repository fix inside the approved scope is clear.

API-only or HTTP-only probes can support diagnosis, but do not complete a use-case E2E gate when
a browser-accessible user-visible UI exists. If browser verification applies and Playwright MCP or
its browser cannot start, record an environment blocker and keep the plan active.

If a command cannot run because of environment limits, record the exact failure in the targeted UC plan
under `11. 검증 실패` and report it as BLOCKED instead of adding code-remediation tasks.

## Completion

Keep the plan active until all of these are true:

- Every checkbox in `docs/plans/active/<UC-ID>/plan.md` is `- [x]`.
- The implemented behavior satisfies `docs/use-cases/<UC-ID>/e2e-goal.md`.
- Required tests exist and pass.
- Build passes.
- Runtime server verification passes, or is explicitly marked not applicable with a reason.
- Static analysis passes.
- Section `10. 검증 결과` records successful commands.
- `docs/plans/active/<UC-ID>/verification.md` or section `10. 검증 결과` records the concrete
  implementation-specific test suite and evidence used to prove the business E2E goal.

Only then move:

```text
docs/plans/active/<UC-ID>/plan.md -> docs/plans/completed/<UC-ID>/plan.md
```

If final verification fails, do not move the plan. Add remediation tasks and delegate back to
`implementation_executor` only when the failure is `IMPLEMENTATION_FAILURE`.
