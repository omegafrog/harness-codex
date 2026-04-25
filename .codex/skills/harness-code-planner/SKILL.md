---
name: harness-code-planner
description: Create or maintain a single executor-ready implementation plan for harness engineering. Use after docs/design artifacts exist and before coding starts, or when updating/completing the active implementation plan. The skill ensures ARCHITECTURE.md exists, records static-analysis procedures in the plan, runs the implementation_planner agent, and writes only docs/plans/active/plan.md or moves it to docs/plans/complete/plan.md after all checkbox tasks and build/test/static-analysis verification are complete.
---

# Harness Code Planner

## Purpose

Create the single active implementation plan that an executor will follow. The planner turns `docs/design` and `ARCHITECTURE.md` into `docs/plans/active/plan.md`.

The planner does not implement code.

## Required Inputs

- `docs/design/요구사항.md`
- `docs/design/유스케이스.md`
- `docs/design/이벤트 스토밍.md`
- `docs/design/details/index.md`
- `docs/design/details/도메인모델.md`
- `docs/design/details/어그리거트.md`
- `docs/design/details/애플리케이션서비스.md`
- `docs/design/details/바운디드컨텍스트.md`
- `ARCHITECTURE.md`

If some design detail files do not exist, the planner may create a plan only if the remaining design docs are sufficient. It must record missing documents as planning risk.

## Preflight Gates

### ARCHITECTURE.md

- If `ARCHITECTURE.md` exists, use it as the executor-facing architecture constraint.
- If `ARCHITECTURE.md` is missing, explicitly run the `$spring-package-structure` skill workflow to create or update it before planning.
- Do not satisfy this gate by manually copying the `spring-package-structure` template or by writing `ARCHITECTURE.md` directly from this planner.
- When invoking `$spring-package-structure`, announce that the skill is being used and follow that skill's input rules, including stopping to ask for root package/modules if they cannot be inferred safely.
- If `spring-package-structure` cannot run, or if root package/modules cannot be inferred well enough to create `ARCHITECTURE.md`, stop and explain what input is needed.
- Do not run `implementation_planner` while `ARCHITECTURE.md` is absent.

### Static Analysis

- Do not invoke `$ddd-architecture-linter` from this planner.
- Do not require static-analysis setup to exist before writing `plan.md`.
- Include static-analysis procedures in `plan.md` so the executor knows what to run or set up.
- If static-analysis tooling is already present, record the concrete commands from the repository.
- If static-analysis tooling is not present, record a setup task for the executor to add or run the DDD architecture linter before final verification.
- The verification section should usually mention ArchUnit and Semgrep, for example `./gradlew architectureRules` and `semgrep --config .semgrep/ddd-architecture.yml src/main/java`, adjusted to the repository and marked as setup-required when not present.

## Invocation

전담 에이전트:

- agent id: `implementation_planner`
- config: `.codex/agents/implementation_planner.toml`
- output file:
  - `docs/plans/active/plan.md`
- completion move:
  - from `docs/plans/active/plan.md`
  - to `docs/plans/complete/plan.md`

실행 규칙:

- 전담 에이전트를 찾을 수 없거나 실행할 수 없으면 현재 에이전트가 대신 수행하지 않는다.
- 실패 이유를 사용자에게 설명하고 멈춘다.
- 전담 에이전트는 코드, 테스트 코드, 설정, 스킬, 에이전트 파일을 수정하지 않는다.
- 전담 에이전트의 쓰기 범위는 `docs/plans/active/plan.md`와 완료 시 `docs/plans/complete/plan.md` 이동으로만 제한한다.
- planner는 `ticketon-ddd블로그` 파일을 읽지 않는다. 테스트 작성 요령은 agent instruction 안에 내장된 기준을 따른다.

## Plan Rules

`plan.md` must include:

- Implementation goal.
- Explicit non-goals: what must not be implemented.
- Design inputs and architecture inputs used.
- Scope boundaries and assumptions.
- Executor constraints from `ARCHITECTURE.md`.
- Spring project/module initialization task using `spring-initializer` when the repository needs a new Spring Boot baseline or a new module.
- A first implementation task to use `spring-package-structure` to create or verify the Spring module/package skeleton against `ARCHITECTURE.md`.
- Implementation checklist using markdown checkboxes.
- Test implementation plan.
- Verification plan with build, tests, and static analysis.
- Static analysis section that records the static-analysis procedure the executor must run or set up.
- Completion policy explaining when to move the plan to `docs/plans/complete/plan.md`.

Checklist rules:

- Use `- [ ]` for pending tasks.
- Executor must change a completed task to `- [x]` immediately after finishing that task.
- Keep tasks small enough to verify independently.
- If the repository is empty, lacks Spring Boot baseline files, or requires a new module, include an initial checkbox telling the executor to use `spring-initializer` before package-structure work.
- After any needed initialization, include a checkbox telling the executor to use `spring-package-structure` to create or verify the module/package structure and `ARCHITECTURE.md` before adding feature code.
- Include test tasks near the implementation task they verify.
- Include a final verification checkbox for build, tests, and static analysis.

Completion rules:

- Do not move the plan to `docs/plans/complete/plan.md` until every checkbox is checked.
- Do not move the plan until build, tests, and static analysis verification are recorded as successful.
- If verification fails, keep the plan in `docs/plans/active/plan.md` and add the failure under `검증 실패`.

## Embedded Test Planning Standards

Use these standards when writing the plan. Do not read blog posts at runtime.

- Domain rules must be tested close to the model that owns the rule.
- Aggregate tests verify state transitions, invariants, and rule violations through aggregate behavior methods.
- Value object tests verify constructor-time validation, immutability expectations, and invalid value rejection.
- Domain service tests verify domain calculations or decisions that require multiple domain concepts.
- Application service tests verify orchestration flow: repositories/ports are called, aggregates are loaded and saved, domain methods are invoked, external ports are used through interfaces, and failure paths trigger compensating actions when required.
- Application service tests must not re-test internal aggregate rules as service logic; those belong in aggregate tests.
- Infrastructure tests verify adapters, persistence mappings, serialization, messaging, local storage, and external technology integration.
- Communication tests verify outbox/inbox behavior, idempotency, message identity, aggregate key ordering, retry metadata, and status checks before consuming events when messaging exists.
- Prefer focused unit tests for domain rules over broad integration tests when no external technology is involved.
- Use integration tests only where persistence, messaging, HTTP clients, framework wiring, or transaction behavior must be verified.
- Test names should describe the business rule or flow outcome.
- Tests should cover success path, important failure path, and boundary conditions.

## Output Template

`docs/plans/active/plan.md` must follow this structure:

```markdown
# Implementation Plan

## 1. 구현 목표
- ...

## 2. 구현하지 말아야 할 것
- ...

## 3. 입력 문서
|문서|사용 목적|상태|
|---|---|---|

## 4. 아키텍처 제약
- ARCHITECTURE.md 기준:
- 모듈/패키지 경계:
- 의존성 방향:
- 금지 참조:

## 5. 구현 범위
- 포함:
- 제외:
- 가정:

## 6. 구현 계획
- [ ] 필요 시 `spring-initializer`를 사용해 Spring Boot 프로젝트 기준 설정 또는 신규 모듈을 초기화한다.
- [ ] `spring-package-structure`를 사용해 Spring 모듈/패키지 빈 구조와 `ARCHITECTURE.md`가 현재 설계와 일치하는지 생성 또는 검증한다.
- [ ] ...

## 7. 테스트 계획
- [ ] Domain/Aggregate/VO 테스트:
- [ ] Application Service 흐름 테스트:
- [ ] Infrastructure/Adapter 테스트:
- [ ] Communication/Transaction 테스트:

## 8. 검증 방법
- [ ] Build:
  - 명령:
  - 성공 기준:
- [ ] Tests:
  - 명령:
  - 성공 기준:
- [ ] Static analysis:
  - 절차:
  - 명령:
  - 성공 기준:

## 9. 완료 조건
- 모든 체크박스가 `- [x]` 상태다.
- 구현 범위의 테스트가 작성되어 통과했다.
- Build, Tests, Static analysis가 성공했다.
- 성공 후 `docs/plans/complete/plan.md`로 이동한다.

## 10. 검증 결과
- Build:
- Tests:
- Static analysis:

## 11. 검증 실패
- 없음
```

## User-Facing Result

After agent completion, report:

- Whether `ARCHITECTURE.md` existed or was created/updated first.
- Whether static-analysis procedures were included in `plan.md`.
- The active plan path or completed plan path.
- Whether the plan is ready for executor use.
- Any missing design or architecture inputs.
