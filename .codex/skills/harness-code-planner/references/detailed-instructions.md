# harness-code-planner Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-code-planner/SKILL.md`

---
name: harness-code-planner
description: Create or maintain an executor-ready implementation plan for one active ChangeSet work item. Use after a ChangeSet and one work-item slice exist and before coding starts, or when updating that active work-item plan. The skill keeps planning scoped to the active ChangeSet and writes only `docs/plans/active/<WORK-ITEM-ID>/plan.md`.
---

# Harness Code Planner

## Purpose

Create or update the executor-ready implementation plan for exactly one work item inside an active ChangeSet.

The planner turns a ChangeSet-local work-item slice, architecture constraints, repository settings, canonical domain references, and approved technical decisions into `docs/plans/active/<WORK-ITEM-ID>/plan.md`.

The planner does not implement code. It does not update integrated source-of-truth design documents. Integrated docs are synced after implementation and verification by the docs-sync/complete workflow.

## Work-item Contract Summary

Plan exactly one work-item slice from `docs/changes/active/<CHG-ID>.md` into `docs/plans/active/<WORK-ITEM-ID>/plan.md`. The planner never moves, deletes, or creates a completed plan path. After verification evidence passes, the workflow's `complete-work-item-plan` git step exclusively owns the active-to-completed transition.

### Implementation ownership boundary

For non-evolve workflows, plan only project-owned implementation writes. The executor may modify application source only inside the plan's `implementationBoundary.source` patterns and tests only inside `implementationBoundary.tests` patterns.

Build, framework/runtime configuration, cache configuration, Docker/Compose files, launcher scripts, and env templates are not blanket writable support files. They are writable only when the active plan lists the exact path or narrow pattern under `implementationBoundary.configExceptions` and also names the corresponding checklist task.

The planner is the sole author of `implementationBoundary`. The executor consumes it but must not decide, rewrite, or widen it. When the executor discovers that a boundary is too narrow, it must stop with `scopeExpansionRequest`; the planner then decides whether to update the boundary.

#### `implementationBoundary.source` authoring rules

- Derive `source` from the active work-item scope, ChangeSet included/excluded scope, repository module/package layout, architecture constraints, and source-map/Graphify evidence when available.
- Use the smallest product source module/package boundary that can plausibly contain the implementation. For unknown bug or maintenance root cause, prefer the smallest relevant module or package, not a single guessed file and not the whole repository.
- For cross-module work, list every writable source module explicitly. Each module must be justified by the work-item intent, a boundary contract, an import/compile/test failure, an event/API/ACL/message/outbox edge, or an approved architecture decision.
- Never use repository-wide wildcards such as `**`, `**/*`, `**/*.py`, or broad root patterns as `source`. `src/**` is allowed only when the repository has one product source module and the work item genuinely owns that whole module.
- Do not put tests, build files, config files, scripts, generated outputs, documentation, runtime artifacts, or harness control-plane paths in `source`. Use `tests`, `configExceptions`, `runtimeArtifacts`, or `protected` instead.
- Do not include `.codex/**`, `.harness/**`, `.harness-codex/**`, `harness_codex/**`, `tests/runtime/**`, `completions/**`, `AGENTS.md`, or `**/AGENTS.md` in normal non-evolve `source` boundaries.
- If no safe source boundary can be derived, block the planner step instead of emitting a permissive boundary.

#### Matching boundary fields

- `implementationBoundary.tests` should mirror the selected source boundary with focused unit/integration test paths. Avoid repository-wide test wildcards unless the repository has one test module and the work item owns it.
- `implementationBoundary.configExceptions` must contain exact paths or narrow patterns for required build/config/script writes. Do not use support-file classes as blanket exceptions.
- `implementationBoundary.runtimeArtifacts` must contain only runtime-owned output paths, active plan state, and run state paths.
- `implementationBoundary.protected` must contain harness-owned control-plane patterns that are blocked for normal executor runs.

The plan must include this machine-readable block inside `## 실행 경계`:

```yaml
implementationBoundary:
  source:
    - <planner-derived product source module patterns>
  tests:
    - <matching focused test boundary patterns>
  runtimeArtifacts:
    - docs/plans/active/<WORK-ITEM-ID>/plan.md
    - .harness/runs/**
    - .harness/state/**
  configExceptions: []
  protected:
    - .harness/system/**
    - .harness/agents/**
    - .harness/contracts/**
    - .harness/docs/**
    - .harness/workflows/**
    - .codex/**
    - harness_codex/**
```

Forbidden non-evolve implementation targets include `AGENTS.md`, `**/AGENTS.md`, `.codex/**`, `.semgrep/**`, `.harness/system/**`, `.harness/agents/**`, `.harness/contracts/**`, `.harness/docs/**`, `.harness/workflows/**`, `.harness-codex/**`, `harness_codex/**`, `tests/runtime/**`, `completions/**`, the root `harness` launcher, `scripts/install-harness-codex.sh`, and `scripts/bump_runtime_version.py`. These may be read only when the planner's own workflow input contract requires them; they are not executor implementation files.

If scope evidence, review evidence, or verifier evidence names one of those forbidden paths, narrow the plan back to project implementation files. Do not solve the failure by adding the forbidden path to the execution boundary.

The sole exception is an explicit evolve workflow/run. In that case, runtime/agent/skill/workflow changes belong to the separate harness evolution run kind, not to normal project implementation.

Always read the selected work-item slice, `ARCHITECTURE.md`, `.codex/repository-settings.md`, approved technical decisions, and the ChangeSet Before/After delta. Use `docs/use-cases/<UC-ID>/` for a use-case work item and `docs/maintenance/<MAINT-ID>/` for a maintenance work item. Integrated documents under the design documentation area are source-of-truth references only. They are not the primary planning input.

### Executor-complete plan contract

The implementation executor receives only the active plan, a runtime-owned execution-scope artifact, and fixed DDD implementation policy. Therefore the plan must be self-sufficient for every task-specific decision. Include these explicit sections exactly as defined by `plan-template.md`:

- `## 실행 경계`: bounded context/module, Aggregate Root, planner-authored `implementationBoundary`, allowed/forbidden paths, and affected existing files.
- `## 패키지 및 의존성 계약`: exact package and responsibility for every created or moved class, allowed dependency direction, forbidden imports/framework dependencies, and composition wiring.
- `## 도메인 구현 계약`: invariants, state transitions, Entity/Value Object validation, Domain Service decision, Domain Events, persistence compatibility, cross-Aggregate/Bounded Context collaboration, transaction/idempotency/concurrency decisions.
- `## 외부 계약 읽기 허용 목록`: every cross-scope read with an exact path/pattern and reason, or explicit `N/A - <reason>`.
- `## 작업 체크리스트`: ordered, file-oriented unchecked tasks for code, tests, configuration, and evidence. Each task names the rule it proves.
- `## 집중 검증`: exact commands, expected results, architecture-test decision, and explicit stop conditions.

Emit these six executor-owned headings exactly as shown, with no numeric prefix, suffix, or alternate wording. For example, write `## 실행 경계`, never `## 3. 실행 경계`. Runtime execution-scope materialization uses exact heading matching for these sections.

Do not write placeholder-like angle-bracket text or paired arrow notation such as `A -> B <- C` in the final plan. Spell those dependency directions as separate bullets so the runtime placeholder detector does not mark the section incomplete.

When updating an existing active plan, first decide whether a plan change is actually required. If the current plan already satisfies the executor-complete contract and no source input changed in a way that affects implementation decisions, do not rewrite or reformat the file. Leave the whole plan byte-for-byte unchanged.

If a plan change is required, make the smallest targeted edit needed to repair the contract. Preserve unaffected sections, wording, and ordering. For affected checklist sections, rewrite toward a clean current-run executor input: remove completed items that need no more work, and turn any item that needs more work into a current-run `- [ ]` task. Do not carry stale prior-run `- [x]` state or old PASS evidence into a rewritten active plan.

For runtime-triggered planner reruns, apply `plan-mutation-policy.md` before editing. The runtime mutation request controls allowed sections and rewrite limits.

Do not require the executor to consult requirements, use-case, event-storming, E2E-goal, ChangeSet, architecture, or technical-decision documents to resolve an implementation decision. Resolve the decision while planning, or mark the planner step blocked without writing an executor plan.

Do not write unresolved `BLOCKER-*`, approval, scope-recovery, token-acquisition, or user-decision checklist items into an active implementation plan. An active plan is a handoff to the implementation executor, so every unchecked checkbox must be actionable inside the declared execution boundary. If a problem is recoverable inside planning, repair the plan directly. If it is not recoverable inside planning, stop the planner step and report the blocker instead of producing a rejected handoff.

Derive `## 실행 경계` and `implementationBoundary` from the ChangeSet included/excluded scope, repository layout, and approved architecture. Do not include a pending scope-recovery task unless the ChangeSet boundary actually forbids the planned files.

Before handing off a plan, inventory known non-source implementation support files the executor may need. This includes build manifests, module settings, application configuration, framework XML/YAML/properties files, cache configuration such as `ehcache.xml`, migration/init SQL, Docker/Compose files, launcher scripts, and env templates. Name every writable support file under `implementationBoundary.configExceptions` and in matching checklist tasks. Unknown support files discovered during implementation must not be edited silently; the executor must stop and request boundary expansion.

Do not describe support-file classes as blanket allowed paths. Reserve `implementationBoundary.configExceptions` for exact paths or narrow patterns that are genuinely required by this work item.

Do not use the fixed DDD policy as a substitute for task-specific design. For example, it can require `ui -> application -> domain`, but the plan must still name the actual package, Aggregate Root, Port, adapter, event, transaction, and compatibility decision for this work item.

### Use-case work-item slice

Required:

- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/ddd-design.md`
- `docs/use-cases/<UC-ID>/technical-decisions.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`

Optional:

- `docs/use-cases/<UC-ID>/requirements-slice.md`
- `docs/use-cases/<UC-ID>/domain-impact.md`
- `docs/use-cases/<UC-ID>/aggregate-delta.md`
- `docs/use-cases/<UC-ID>/source-map.md`

### Maintenance work-item slice

Maintenance work items are not use cases. Never invent, request, or materialize a `docs/use-cases/<UC-ID>/` path for them.

Required:

- `docs/maintenance/<MAINT-ID>/scope.md`
- `docs/maintenance/<MAINT-ID>/change-intent.md`
- `docs/maintenance/<MAINT-ID>/maintenance-spec.md`
- `docs/maintenance/<MAINT-ID>/architecture-impact.md`
- `docs/maintenance/<MAINT-ID>/verification-goal.md`
- `docs/maintenance/<MAINT-ID>/links.md`

The scope record must name the bounded context and the smallest affected aggregate, application service, module/package, adapter, or port. `architecture-impact.md` is always an assessment; `Decision: none` is valid when the change does not alter a canonical architecture contract. When the decision is `update`, `create`, or `adr`, put the exact canonical architecture document changes in the plan.

Optional:

- `docs/maintenance/<MAINT-ID>/technical-decisions.md`
- `docs/maintenance/<MAINT-ID>/domain-impact.md`
- `docs/maintenance/<MAINT-ID>/source-map.md`

## Verification and Domain Planning Requirements

- Stop when a required work-item document is absent. Do not substitute a UC slice for a maintenance slice.
- Treat optional `technical-decisions.md` as a planning reference only; it does not create a maintenance preflight gate.
- Include build and test verification such as `./gradlew build` and `./gradlew test`, or the concrete repository equivalents from `.codex/test-gate.yaml` and `.codex/repository-settings.md`.
- Include E2E or maintenance verification tied to the approved E2E/verification goal. The verifier, not the executor, owns final E2E quality judgment.
- Authentication/runtime credentials are implementation-environment details, not plan approval blockers. If an approved E2E goal needs a token and no in-scope token acquisition path is documented, choose the strongest in-scope verification route: focused controller/application tests, launcher/runtime health, and explicit maintenance verification commands. Do not leave a pending JWT/token approval checkbox in the plan. Record gateway E2E as an optional manual follow-up only when it is outside the current execution boundary.
- Include `domain-impact.md`, `aggregate-delta.md`, and canonical references such as `docs/domain/<BC-ID>/aggregates/<AGG-ID>.md` whenever the work item affects domain elements.
- Add Compatibility tests when another use case shares a modified domain element.
- Block or coordinate when another active ChangeSet modifies the same canonical domain element.
- For browser-accessible UI that calls another local origin, require a same-origin proxy or backend CORS configuration for the frontend origin, methods, and request headers.
- For runnable applications, preserve the versioned launcher contract and plan the full app runtime lifecycle. Any runtime scripts, Compose files, Dockerfiles, or env templates must be listed under `implementationBoundary.configExceptions`; otherwise the executor must request scope expansion instead of editing them.

## Terminology discipline

Use architectural terms without repository-specific assumptions:

- `application layer` or `application service` means the bounded-context internal use-case orchestration layer.
- `app module` means a runnable composition or bootstrapping module only when the repository actually has that module concept.

Do not write plan tasks that conflate `application service` rules with `app module` rules. If both concepts exist, name both explicitly and state which files or packages belong to each scope.

When a work item may need files outside the selected bounded context, plan only the minimal external contract reads needed for the active path. Name the reason generically, such as event schema, port contract, adapter contract, runtime configuration, focused test failure, or compile/import contract. Do not hardcode unrelated module examples into the general workflow.

## Package taxonomy discipline

Preserve repository package taxonomy exactly. The planner must not normalize, translate, or improve layer package names by convention.

- If a module uses `ui/application/domain/infra`, plan work under `ui`, `application`, `domain`, and `infra`.
- Do not introduce sibling `controller`, `service`, `presentation`, or `infrastructure` packages unless `ARCHITECTURE.md`, `.codex/repository-settings.md`, or the user's request explicitly names them.
- Treat classes named `*Controller` as allowed inside a repository's `ui` package when that is the established adapter layer. Treat application services as classes inside `application`, not as a reason to create a `service` layer package.

## Reference Map

Load only the reference needed for the current step. Content was split from this file without semantic changes.
- gates.md: ## Scope Model to ## Invocation.
- invocation.md: ## Invocation to ## Plan Rules.
- plan-rules.md: ## Plan Rules to ## Embedded Test Planning Standards.
- plan-mutation-policy.md: current-run rewrite rules for runtime-triggered planner reruns.
- test-standards.md: ## Embedded Test Planning Standards to ## Output Template.
- plan-template.md: ## Output Template to EOF.
