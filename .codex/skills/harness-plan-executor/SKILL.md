---
name: harness-plan-executor
description: Orchestrate execution of docs/plans/active/plan.md for harness engineering by delegating code implementation to the implementation_executor agent, running final verification, adding remediation plan tasks after verification failures, and repeating until verification passes or a real blocker is documented.
---

# Harness Plan Executor

## Purpose

Orchestrate execution of the active plan in `docs/plans/active/plan.md`.

This skill does not implement product code directly. It delegates implementation to
`.codex/agents/implementation_executor.toml`, runs final verification, updates `plan.md`
with remediation tasks after verification failures, and repeats the implementation/verification
loop until verification passes or a real blocker is documented.

## Required Inputs

- `docs/plans/active/plan.md`
- `ARCHITECTURE.md`
- `docs/design/요구사항.md`
- `docs/design/유스케이스.md`
- `docs/design/이벤트 스토밍.md`
- `docs/design/details/index.md`
- `docs/design/details/도메인모델.md`
- `docs/design/details/어그리거트.md`
- `docs/design/details/애플리케이션서비스.md`
- `docs/design/details/바운디드컨텍스트.md`

If `plan.md` or `ARCHITECTURE.md` is missing, stop. Do not invent a plan or architecture.

## Required Agent

- agent id: `implementation_executor`
- config: `.codex/agents/implementation_executor.toml`

If the implementation executor agent cannot be found or invoked, stop. Do not implement code
from this skill as a fallback.

## Source Priority

Use sources in this order:

1. `docs/plans/active/plan.md`
2. `ARCHITECTURE.md`
3. `docs/design/**`
4. Existing repository code and build configuration

If sources conflict, follow `plan.md` for task order and scope, then `ARCHITECTURE.md` for structural constraints. Record the conflict in `plan.md` under `검증 실패` or a short executor note before continuing.

Do not read `ticketon-ddd블로그` at runtime.

## Hard Scope Rules

- Do not implement code directly from this skill.
- Delegate product code, tests, build/config edits, and focused task verification to `implementation_executor`.
- Do not add features, domain rules, integrations, UI flows, infrastructure, or dependencies outside `plan.md`.
- Do not change requirements or architecture documents unless the active plan explicitly requires it.
- Do not mark implementation checkboxes complete yourself unless you are recording results already completed by `implementation_executor`.
- Do not move `docs/plans/active/plan.md` to `docs/plans/complete/plan.md` until every checkbox is checked and build, tests, and static analysis are recorded as successful.
- Preserve user changes. Never revert unrelated work.

## Execution Workflow

1. Read `plan.md`, `ARCHITECTURE.md`, and the relevant design docs.
2. Identify unchecked implementation/test/setup tasks in `plan.md`.
3. Invoke `implementation_executor` to execute the unchecked tasks. The executor owns code edits, test edits, build/config edits required by the plan, focused verification, and checkbox updates.
4. When `implementation_executor` stops, inspect `plan.md` and the executor report.
5. If unchecked tasks remain because of a blocker, report the blocker and stop.
6. If all tasks are checked, run final verification from `plan.md` section `8. 검증 방법`.
7. Record final verification results in section `10. 검증 결과`.
8. If final verification passes, move `docs/plans/active/plan.md` to `docs/plans/complete/plan.md`.
9. If final verification fails, classify the failure before adding remediation tasks. Add remediation only for implementation-level failures. Stop and report to the user for design/requirements/architecture/technical-decision failures.

## Verification Failure Loop

When final verification fails after all planned tasks were executed:

1. Record the failed command, exit result, and concise failure evidence under `11. 검증 실패`.
2. Classify the failure:
   - **Implementation-level failure**: code does not match the approved plan, tests expose a missing branch, mapping/configuration is incomplete, static analysis finds a fixable package/dependency violation, or a verification command fails because of an implementation mistake inside the approved scope.
   - **Upstream design failure**: requirements, use cases, event storming, DDD design, technical decisions, or ARCHITECTURE.md are inconsistent, incomplete, impossible to implement safely, or contradicted by tests/static analysis in a way that requires changing approved design artifacts.
   - **Environment blocker**: permissions, unavailable external services, missing local tools that cannot be installed in this run, network, credentials, or host constraints prevent verification.
3. For upstream design failures, do not add remediation tasks. Add a blocker section to `plan.md` and stop:

```markdown
## 12. 상위 설계 재검토 필요
- 실패 유형: 요구사항/설계/아키텍처/기술결정 불일치
- 실패 증거:
- 왜 plan executor에서 고칠 수 없는가:
- 되돌아갈 단계:
- 사용자 확인 필요:
```

4. Report the blocker to the user and name the stage to revisit, such as `$harness-requirements-usecases`, `$harness-event-storming`, `$harness-ddd-design`, `$harness-technical-decisions`, or `$harness-code-planner`.
5. For environment blockers, do not add code-remediation tasks. Record the blocker and ask the user for the missing permission/tool/service.
6. Only for implementation-level failures, add a new unchecked remediation section to `plan.md`, for example:

```markdown
## 12. 재실행 계획 N
- [ ] 실패 원인을 수정한다: <specific failing test/build/static-analysis issue>
- [ ] 수정 범위를 검증하는 테스트 또는 정적 분석을 보강한다.
- [ ] 실패했던 최종 검증 명령을 다시 실행한다.
```

7. Keep the plan in `docs/plans/active/plan.md`.
8. Invoke `implementation_executor` again to execute only the newly added unchecked remediation tasks.
9. Re-run final verification.
10. Repeat until build, tests, and static analysis all pass or a non-implementation blocker is found.

## Upstream Failure Signals

Treat a final verification failure as upstream design failure, not an implementation remediation, when any of these are true:

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

- final verification passes, or
- the failure is an upstream design/requirements/architecture/technical-decision issue that must return to the user, or
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

Use the test scope in `plan.md`.

- Domain/Aggregate/VO tests verify invariants, state transitions, invalid values, and boundary conditions.
- Domain service tests verify domain calculations and decisions.
- Application service tests verify orchestration, port calls, save order, and failure/fallback paths.
- Infrastructure tests verify adapters, serialization, persistence/local-storage mapping, and Spring wiring.
- Communication/transaction tests verify cross-BC call order, state consistency, duplicate prevention, and save/fallback behavior.

Do not use application service tests to re-test aggregate internals.

## Verification

Follow `plan.md` section `8. 검증 방법`.

Typical final commands are:

```bash
./gradlew build
./gradlew test
./gradlew architectureRules
semgrep --config .semgrep/ddd-architecture.yml .
```

If static-analysis tooling is not installed yet, implement the setup task described in `plan.md` before final verification.

If a command cannot run because of environment limits, record the exact failure in `plan.md`
under `11. 검증 실패` and report it as BLOCKED instead of adding code-remediation tasks.

## Completion

Keep the plan active until all of these are true:

- Every checkbox in `plan.md` is `- [x]`.
- Required tests exist and pass.
- Build passes.
- Static analysis passes.
- Section `10. 검증 결과` records successful commands.

Only then move:

```text
docs/plans/active/plan.md -> docs/plans/complete/plan.md
```

If final verification fails, do not move the plan. Add remediation tasks and delegate back to
`implementation_executor`.
