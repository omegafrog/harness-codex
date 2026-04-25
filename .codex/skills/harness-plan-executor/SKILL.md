---
name: harness-plan-executor
description: Execute docs/plans/active/plan.md for harness engineering. Use when implementing the active plan, updating its checkboxes, and verifying work while constrained to ARCHITECTURE.md and docs/ design artifacts.
---

# Harness Plan Executor

## Purpose

Implement the active plan in `docs/plans/active/plan.md` exactly as written.

This skill is for execution, not replanning. The executor must read `ARCHITECTURE.md`, `docs/` design artifacts, and the active plan before coding, then implement only the checked plan scope.

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

## Source Priority

Use sources in this order:

1. `docs/plans/active/plan.md`
2. `ARCHITECTURE.md`
3. `docs/design/**`
4. Existing repository code and build configuration

If sources conflict, follow `plan.md` for task order and scope, then `ARCHITECTURE.md` for structural constraints. Record the conflict in `plan.md` under `검증 실패` or a short executor note before continuing.

Do not read `ticketon-ddd블로그` at runtime.

## Hard Scope Rules

- Do not implement anything absent from `plan.md`.
- Do not add features, domain rules, integrations, UI flows, infrastructure, or dependencies because they seem useful.
- Do not change requirements or architecture documents unless the active plan explicitly requires it.
- Do not mark a checkbox complete until the corresponding code and tests are done.
- Do not move `docs/plans/active/plan.md` to `docs/plans/complete/plan.md` until every checkbox is checked and build, tests, and static analysis are recorded as successful.
- Preserve user changes. Never revert unrelated work.

## Execution Workflow

1. Read `plan.md`, `ARCHITECTURE.md`, and the relevant design docs.
2. Identify the first unchecked checkbox in `plan.md`.
3. Execute that task only. If the task names another skill, explicitly use that skill before coding:
   - `spring-initializer` for Spring Boot project/module initialization.
   - `spring-package-structure` for module/package skeleton and `ARCHITECTURE.md` structure verification.
   - `ddd-architecture-linter` only when the plan reaches static-analysis setup or verification.
4. Add or update focused tests next to the implementation task they verify.
5. Run the narrowest useful verification for the completed task.
6. Update that checkbox from `- [ ]` to `- [x]` immediately after the task is complete and verified.
7. Continue to the next unchecked task when feasible.
8. After all implementation and test tasks are checked, run final verification and record results in section `10. 검증 결과`.

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

If a command cannot run because of environment limits, record the exact failure in `plan.md` under `11. 검증 실패` and report it.

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
