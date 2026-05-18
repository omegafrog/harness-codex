---
name: harness-code-planner
description: Create or maintain an executor-ready implementation plan for one active ChangeSet work item. Use after a ChangeSet and one work-item slice exist and before coding starts, or when updating/completing that work-item plan. The skill keeps planning scoped to the active ChangeSet, writes only docs/plans/active/<WORK-ITEM-ID>/plan.md, and moves it to docs/plans/completed/<WORK-ITEM-ID>/plan.md only after all checkbox tasks and build/test/e2e/runtime-server/static-analysis verification are complete.
---

# Harness Code Planner

## Purpose

Create or update the executor-ready implementation plan for exactly one work item inside an active ChangeSet.

The planner turns a ChangeSet-local work-item slice, architecture constraints, repository settings, canonical domain references, and approved technical decisions into `docs/plans/active/<WORK-ITEM-ID>/plan.md`.

The planner does not implement code. It does not update integrated source-of-truth design documents. Integrated docs are synced after implementation and verification by the docs-sync/complete workflow.

## Scope Model

- ChangeSet: `docs/changes/active/<CHG-ID>.md`
- Work item:
  - use case: `docs/use-cases/<UC-ID>/`
  - maintenance: `docs/maintenance/<MAINT-ID>/`
- Active plan: `docs/plans/active/<WORK-ITEM-ID>/plan.md`
- Completed plan: `docs/plans/completed/<WORK-ITEM-ID>/plan.md`

`<WORK-ITEM-ID>` is the concrete use-case ID or maintenance ID selected by the parent workflow.

## Required Inputs

### Always required

- `docs/changes/active/<CHG-ID>.md`
- One selected work-item slice:
  - `docs/use-cases/<UC-ID>/` for a use-case work item, or
  - `docs/maintenance/<MAINT-ID>/` for a maintenance work item
- `ARCHITECTURE.md`
- `.codex/repository-settings.md`
- approved technical decisions relevant to the work item

### Use-case work-item slice

Required:

- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`

Optional but should be read when present:

- `docs/use-cases/<UC-ID>/requirements-slice.md`
- `docs/use-cases/<UC-ID>/domain-impact.md`
- `docs/use-cases/<UC-ID>/aggregate-delta.md`
- `docs/use-cases/<UC-ID>/ddd-design.md`
- `docs/use-cases/<UC-ID>/technical-decisions.md`
- `docs/use-cases/<UC-ID>/source-map.md`

### Maintenance work-item slice

Required:

- `docs/maintenance/<MAINT-ID>/change-intent.md`
- `docs/maintenance/<MAINT-ID>/affected-files.md`
- `docs/maintenance/<MAINT-ID>/verification-goal.md`

Optional but should be read when present:

- `docs/maintenance/<MAINT-ID>/technical-decisions.md`
- `docs/maintenance/<MAINT-ID>/domain-impact.md`
- `docs/maintenance/<MAINT-ID>/source-map.md`

### Canonical domain references

When `domain-impact.md`, `aggregate-delta.md`, or the ChangeSet names canonical domain elements, read the referenced files under paths such as:

- `docs/domain/<BC-ID>/aggregates/<AGG-ID>.md`
- `docs/domain/<BC-ID>/entities/<ENTITY-ID>.md`
- `docs/domain/<BC-ID>/value-objects/<VO-ID>.md`
- `docs/domain/<BC-ID>/domain-services/<SERVICE-ID>.md`
- `docs/domain/<BC-ID>/ports/<PORT-ID>.md`

The work-item slice records impact and delta. It must not become the canonical source of truth for aggregates, entities, value objects, domain services, or ports.

### Integrated docs

Integrated documents under the design documentation area are source-of-truth references only. They are not the primary planning input for this skill, and this planner must not update them. Use the ChangeSet-local work-item slice as the planning source. Integrated docs are updated later by docs-sync after implementation and verification pass.

## Preflight Gates

### ChangeSet and work-item selection

- If `docs/changes/active/<CHG-ID>.md` does not exist or the ChangeSet ID is unclear, stop and explain that the parent ChangeSet workflow must select a ChangeSet first.
- If the work-item ID is unclear, stop and ask the parent workflow to pass exactly one work item.
- If both a use-case slice and a maintenance slice appear applicable, stop and ask the parent workflow to select one work-item type.
- If no work-item slice exists for the selected work item, stop and list the expected slice path.

### Use-case gate

For a use-case work item:

- If `use-case.md`, `event-storming.md`, or `e2e-goal.md` is missing, stop and list the missing files.
- If `e2e-goal.md` is not explicitly approved by the user, stop and list what must be approved.

### Maintenance gate

For a maintenance work item:

- If `change-intent.md`, `affected-files.md`, or `verification-goal.md` is missing, stop and list the missing files.
- If `verification-goal.md` is not explicit enough to verify the change, stop and ask the parent workflow to clarify the verification goal.

### Architecture gate

- If `ARCHITECTURE.md` exists, use it as the executor-facing architecture constraint.
- If `ARCHITECTURE.md` is missing, stop and explain that the parent skill must run or complete package-structure/architecture setup first.
- Do not write `ARCHITECTURE.md` directly from this planner.

### Technical decision gate

- Read work-item technical decisions when present.
- Read repository-level approved technical decisions when referenced by the ChangeSet, work-item slice, or repository settings.
- If a referenced technical decision is unresolved and blocks implementation, stop and list what must be confirmed.
- Do not invent technical decisions to fill gaps.

### Domain conflict gate

- If the ChangeSet or `domain-impact.md` lists affected domain elements, capture their type, ID, mode, and canonical path.
- If another active ChangeSet modifies the same aggregate, entity, value object, domain service, or port, block or require explicit rebase/coordination.
- If one work item modifies a domain element and another only reuses it, record that the planner must read the latest canonical domain reference.
- If the same port/entity/value object would be created in incompatible shapes, stop and report a domain conflict.

### Static analysis gate

- Do not invoke architecture-linting skills from this planner.
- Do not require static-analysis setup to exist before writing the plan.
- Include static-analysis procedures in the plan so the executor knows what to run or set up.
- If static-analysis tooling is already present, record concrete commands from the repository.
- If static-analysis tooling is missing, add executor tasks to set up or run ArchUnit/Semgrep-based architecture linting before final verification.

## Invocation

Dedicated agent:

- agent id: `implementation_planner`
- config: `.codex/agents/implementation_planner.toml`
- output file:
  - `docs/plans/active/<WORK-ITEM-ID>/plan.md`
- completion move:
  - from `docs/plans/active/<WORK-ITEM-ID>/plan.md`
  - to `docs/plans/completed/<WORK-ITEM-ID>/plan.md`

Execution rules:

- If the dedicated agent cannot be found or executed, do not perform the agent's work in this skill. Explain the blocker and stop.
- The dedicated agent must not edit production code, test code, build files, CI files, configuration files, skill files, or agent files.
- The dedicated agent's write scope is limited to:
  - `docs/plans/active/<WORK-ITEM-ID>/plan.md`
  - `docs/plans/completed/<WORK-ITEM-ID>/plan.md` only when moving a fully completed and verified plan
- The planner must not update integrated design docs. That belongs to docs-sync after the work item is implemented and verified.
- The planner must not read blog markdown files as planning standards. Test planning standards are embedded in the agent instruction and this skill.

## Plan Rules

The work-item plan must include:

- Implementation goal for the selected ChangeSet work item.
- Explicit non-goals: what must not be implemented.
- ChangeSet ID, work-item ID, work-item type, and work-item slice path.
- Input document table, including present/missing/optional status.
- ChangeSet Before/After delta and implementation scope boundary.
- E2E goal for use-case work items or verification goal for maintenance work items.
- Architecture constraints from `ARCHITECTURE.md`.
- Repository settings from `.codex/repository-settings.md`.
- Approved technical decisions and how each maps to implementation, tests, and verification.
- Domain impact:
  - reused existing aggregate/entity/value object/domain service/port
  - new domain element to create
  - existing domain element to modify
  - canonical domain reference files read
  - compatibility tests for existing use cases that share the domain element
- Scope assumptions and unresolved risks.
- Spring project/module initialization task using `spring-initializer` when the repository needs a new Spring Boot baseline or a new module.
- A structural task to use `spring-package-structure` to create or verify the Spring module/package skeleton against `ARCHITECTURE.md` before feature code.
- Implementation checklist using markdown checkboxes.
- Matching test tasks.
- Verification tasks for build, tests, E2E or maintenance verification, test gate, runtime server verification, and static analysis.
- Runtime server verification after build/test tasks. The plan must specify the local run command, usually `./gradlew bootRun` or the repository's existing command, and concrete behavior checks through HTTP/API/UI when the feature has a runtime surface.
- If there is no runnable server or no server-visible behavior, state runtime server verification is not applicable and explain why.
- Completion policy explaining when to move the active plan to the completed path.

## Checklist Rules

- Use `- [ ]` for pending tasks.
- Executor must change a completed task to `- [x]` immediately after finishing that task.
- Keep tasks small enough to verify independently.
- If Spring baseline initialization or module addition is needed, the first implementation checkbox must instruct the executor to use `spring-initializer` before package-structure work.
- After any needed initialization, include a checkbox instructing the executor to use `spring-package-structure` to create or verify module/package structure and `ARCHITECTURE.md` before adding feature code.
- Include test tasks near the implementation task they verify.
- Keep final verification tasks unchecked until the command has succeeded and the result is recorded.

## Completion Rules

- Keep the plan at `docs/plans/active/<WORK-ITEM-ID>/plan.md` while any checkbox is unchecked.
- Keep the plan active if build, tests, E2E or maintenance verification, runtime server verification, test gate, or static analysis failed or were not run, unless runtime server verification is explicitly marked not applicable with a reason.
- Move the plan to `docs/plans/completed/<WORK-ITEM-ID>/plan.md` only when:
  - every checkbox is checked
  - tests required by the plan exist
  - build succeeded
  - tests succeeded
  - E2E or maintenance verification succeeded when applicable
  - `.codex/test-gate.yaml` required stages passed
  - runtime server verification succeeded or is explicitly not applicable with a reason
  - static analysis succeeded
  - verification results are recorded in the plan
- Integrated docs and canonical domain docs should be synced by docs-sync/doc-verify before completing the ChangeSet. This planner records the need but does not perform that sync.

## Embedded Test Planning Standards

Use these standards when writing the plan. Do not read blog posts at runtime.

- Domain rules must be tested close to the model that owns the rule.
- Aggregate tests verify state transitions, invariants, and rule violations through aggregate behavior methods.
- Value object tests verify constructor-time validation, immutability expectations, and invalid value rejection.
- Domain service tests verify domain calculations or decisions that require multiple domain concepts.
- Application service tests verify orchestration flow: repositories/ports are called, aggregates are loaded and saved, domain methods are invoked, external ports are used through interfaces, and failure paths trigger compensating actions when required.
- Application service tests must not re-test internal aggregate rules as service logic; those belong in aggregate tests.
- Infrastructure tests verify adapters, persistence mappings, serialization, messaging, local storage, framework wiring, and external technology integration.
- Communication tests verify outbox/inbox behavior, idempotency, message identity, aggregate key ordering, retry metadata, and status checks before consuming events when messaging exists.
- Compatibility tests must cover existing use cases that share a modified aggregate, entity, value object, domain service, or port.
- Prefer focused unit tests for domain rules over broad integration tests when no external technology is involved.
- Use integration tests only where persistence, messaging, HTTP clients, framework wiring, or transaction behavior must be verified.
- Test names should describe the business rule or flow outcome.
- Tests should cover success path, important failure path, and boundary conditions.

## Output Template

`docs/plans/active/<WORK-ITEM-ID>/plan.md` must follow this structure:

```markdown
# Implementation Plan

## 1. 구현 목표
- ...

## 2. 구현하지 말아야 할 것
- ...

## 3. 입력 문서
|문서|사용 목적|상태|
|---|---|---|

## 3.1 ChangeSet 및 Work Item
- ChangeSet:
- Work item ID:
- Work item type:
- Work item slice:
- E2E/verification goal:

## 4. 아키텍처 제약
- ARCHITECTURE.md 기준:
- 모듈/패키지 경계:
- 의존성 방향:
- 금지 참조:

## 5. 구현 범위
- 포함:
- 제외:
- 가정:

## 5.1 승인된 기술 결정
|영역|결정|구현 반영|테스트/검증 반영|
|---|---|---|---|

## 5.2 도메인 영향
|type|id|mode|canonical path|plan impact|
|---|---|---|---|---|

## 5.3 호환성 확인
- 기존 유스케이스 영향:
- 같은 도메인 요소를 수정하는 active ChangeSet 충돌 여부:

## 6. 구현 계획
- [ ] 필요 시 `spring-initializer`를 사용해 Spring Boot 프로젝트 기준 설정 또는 신규 모듈을 초기화한다.
- [ ] `spring-package-structure`를 사용해 Spring 모듈/패키지 빈 구조와 `ARCHITECTURE.md`가 현재 설계와 일치하는지 생성 또는 검증한다.
- [ ] ...

## 7. 테스트 계획
- [ ] Domain/Aggregate/VO 테스트:
- [ ] Application Service 흐름 테스트:
- [ ] Infrastructure/Adapter 테스트:
- [ ] Communication/Transaction 테스트:
- [ ] Compatibility 테스트:

## 8. 검증 방법
- [ ] Build:
  - 명령: `./gradlew build`
  - 성공 기준:
- [ ] Tests:
  - 명령: `./gradlew test`
  - 성공 기준:
- [ ] E2E 또는 maintenance verification:
  - 명령:
  - 목표:
  - 성공 기준:
- [ ] Test gate:
  - 기준: `.codex/test-gate.yaml` required stage PASS
- [ ] Runtime server verification:
  - 서버 실행 명령:
  - 구현사항 확인 방법:
  - 성공 기준:
- [ ] Static analysis:
  - 절차:
  - 명령:
  - 성공 기준:

## 9. 완료 조건
- 모든 체크박스가 `- [x]` 상태다.
- 구현 범위의 테스트가 작성되어 통과했다.
- Build, Tests, E2E 또는 maintenance verification, Test gate, Runtime server verification, Static analysis가 성공했다.
- 검증 결과가 기록되어 있다.
- 성공 후 `docs/plans/completed/<WORK-ITEM-ID>/plan.md`로 이동한다.

## 10. 검증 결과
- Build:
- Tests:
- E2E 또는 maintenance verification:
- Test gate:
- Runtime server verification:
- Static analysis:

## 11. 검증 실패
- 없음
```

## User-Facing Result

After agent completion, report:

- Whether `ARCHITECTURE.md` existed.
- Whether static-analysis procedures were included in the work-item plan.
- The active plan path or completed plan path.
- Whether the plan is ready for executor use.
- Any missing ChangeSet, work-item, architecture, repository setting, technical decision, or canonical domain inputs.
