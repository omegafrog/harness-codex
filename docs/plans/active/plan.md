# Implementation Plan

## 1. Implementation Goal
- Implement `UC-001` in `ui/` so an end user can enter a full arithmetic expression, trigger explicit calculation, and see either the correct numeric result or `ERROR`.
- Keep evaluation frontend-only in the browser, apply operator precedence, support parentheses/decimals/negative numbers, and format long decimal results to 10 decimal places.
- Prepare executor work so Vitest, Playwright, Vite runtime verification, and static analysis can verify the delivered behavior.

## 2. Non-Goals
- Do not implement backend APIs, Python runtime behavior, file persistence, shared storage, analytics, messaging, or history.
- Do not reintroduce CLI behavior, undo, latest-result continuation, memory buttons, percent, exponentiation, or square root.
- Do not expand into `UC-002`, `UC-003`, or `UC-004` beyond the minimum UI state needed to execute `UC-001`.
- Do not modify canonical `docs/design/**` or use-case slices outside `UC-001`.

## 3. Input Documents
|Document|Purpose|Status|
|---|---|---|
|`docs/changes/active/CHG-20260507-001.md`|ChangeSet scope, before/after boundary, forbidden changes|available|
|`docs/use-cases/UC-001/use-case.md`|UC-001 flow, outcomes, non-functional rules|available|
|`docs/use-cases/UC-001/event-storming.md`|Commands, events, policies, invariants for calculation flow|available|
|`docs/use-cases/UC-001/e2e-goal.md`|Approved E2E success target|available, approved|
|`docs/use-cases/UC-001/affected-files.md`|Expected code/test impact area and forbidden paths|available|
|`docs/use-cases/UC-001/ddd-design.md`|UC-specific design detail|not present, not required because canonical design docs are available|
|`docs/use-cases/UC-001/technical-decisions.md`|UC-specific technical decisions|not present, use canonical approved technical decisions|
|`docs/design/요구사항.md`|Canonical product scope|available|
|`docs/design/유스케이스.md`|Canonical use-case alignment|available|
|`docs/design/이벤트 스토밍.md`|Canonical event-storming summary/index|available|
|`docs/design/details/index.md`|Canonical DDD design index|available|
|`docs/design/details/도메인모델.md`|Approved domain model direction|available|
|`docs/design/details/어그리거트.md`|Approved aggregate/root direction|available|
|`docs/design/details/애플리케이션서비스.md`|Approved application-service and repository interface direction|available|
|`docs/design/details/바운디드컨텍스트.md`|Approved bounded-context boundaries|available|
|`docs/design/기술결정.md`|Approved implementation/test decisions|available, approved|
|`ARCHITECTURE.md`|Executor-facing UI structure and dependency rules|available|
|`.codex/repository-settings.md`|Repo commands, runtime command, verification expectations|available|
|`ui/package.json`|Current frontend scripts and missing setup signals|available|

## 3.1 ChangeSet And E2E Goal
- ChangeSet: `CHG-20260507-001`
- UC ID: `UC-001`
- ChangeSet before/after delta: replace stale Python CLI calculator scope with static React + TypeScript + Vite web calculator scope.
- E2E success target: user enters a valid or invalid expression in a supported desktop browser, triggers `=` or `Calculate`, then sees the correct result or `ERROR`; long decimal output shows 10 decimal places.

## 4. Architecture Constraints
- `ARCHITECTURE.md` baseline: implement calculator feature code in `ui/`, with primary runtime surface in the browser UI.
- Module/path boundary: keep calculator feature work under `ui/src/`; current concrete entrypoints include `ui/src/App.tsx`, `ui/src/main.tsx`, and existing shared UI primitives under `ui/src/components/ui/`.
- Dependency direction: presentation/UI -> application orchestration -> domain logic; infrastructure/browser adapters -> application contracts -> domain logic.
- Required separation: expression evaluation rules must stay out of React presentation code; repository interface must stay separate from in-memory repository implementation.
- Forbidden references: no dependency from `ui/` calculator feature code into `harness_codex/`; no backend or third-party calculator calls; no canonical doc edits during implementation.

## 5. Implementation Scope
- Included: calculator expression capture surface needed for `UC-001`, explicit calculate action, parse/evaluate/format/error flow, in-memory current-session state handling, result rendering, and frontend tests/verifications for approved `UC-001`.
- Excluded: dedicated edit/delete/backspace behavior from `UC-002`, clear behavior from `UC-003`, failure-retry behavior from `UC-004`, and any non-frontend persistence or service integration.
- Assumptions:
  - Current `ui/` app is the only production surface for this UC.
  - Executor may introduce feature-oriented folders under `ui/src/` to satisfy architecture rules.
  - Missing frontend test scripts/configuration and missing `.codex/test-gate.yaml` are setup work for executor, not blockers for this plan.

## 5.1 Approved Technical Decisions
|Area|Decision|Implementation Impact|Test/Verification Impact|
|---|---|---|---|
|Frontend stack|Use TypeScript + React + Vite|Keep implementation in `ui/` and align with existing Vite entrypoints|Build/runtime verification uses Vite commands|
|Runtime scope|Static desktop-browser web app only|No server-side calculator logic or Python runtime changes|Runtime verification must happen against local Vite app in browser|
|Persistence|No persistence beyond in-memory page-session state|Use current-session in-memory state only|Tests must avoid file/storage dependencies|
|Repository direction|Application layer depends on `CalculatorSessionRepository` interface only|Define repository contract separately from adapter even in frontend-only implementation|Application tests should verify contract usage, not concrete implementation leakage|
|Concrete repository|In-memory adapter only for v1|Implement browser/in-memory adapter, defer file-backed storage|Infrastructure tests should cover in-memory adapter behavior|
|Expression evaluation|Keep parsing/evaluation in `ExpressionEvaluationService` and return `EvaluationOutcome`|Do not place parsing or error decision logic in component handlers|Domain tests must cover precedence, parentheses, decimals, negatives, invalid syntax, invalid operations|
|Result formatting|Long decimal results display to 10 decimal places|Centralize formatting in domain/application calculation flow|Tests and runtime checks must assert 10-decimal output such as `1/3 -> 0.3333333333`|
|Validation behavior|No auto-correction; invalid/incomplete expressions show `ERROR` only after explicit calculation|UI may display raw input, but calculate path must return `ERROR` on invalid/incomplete expressions|Vitest/Playwright/runtime checks must cover invalid and incomplete inputs|
|Observability|Browser-console error logs only for unexpected failures|Do not add analytics or remote logging|Runtime verification should note console remains primary operational signal|
|Test strategy|Use Vitest + Playwright|Executor must add missing scripts/config if absent|Verification plan requires `npm run test` and `npm run test:e2e` once setup exists|

## 6. Implementation Checklist
- [ ] Review `ui/src/App.tsx`, `ui/src/main.tsx`, existing UI primitives, and decide the concrete calculator feature folders under `ui/src/` that satisfy `ARCHITECTURE.md`.
- [ ] Introduce calculation domain types/services in `ui/src/` that can parse and evaluate full arithmetic expressions with operator precedence, parentheses, decimals, and negative numbers, and return an `EvaluationOutcome`.
- [ ] Implement numeric result formatting in the calculation flow so long decimal outputs are rendered to 10 decimal places without moving formatting logic into React presentation code.
- [ ] Define an application-layer calculation orchestration path and a `CalculatorSessionRepository` interface for current-session calculator state so the application layer depends on the interface only.
- [ ] Implement the v1 in-memory repository adapter behind the repository interface and keep it separate from presentation components.
- [ ] Implement or update the UC-001 UI flow in `ui/src/` so the user can provide a full expression, trigger `=` or `Calculate`, and see either the numeric result or `ERROR`.
- [ ] Keep the UC-001 implementation inside ChangeSet boundaries: no backend calls, no persistence beyond in-memory session state, no CLI behavior, no undo, no latest-result continuation, no history.
- [ ] Add missing frontend test infrastructure in `ui/` for Vitest if `npm run test` is not already wired, including package updates, config, and scripts needed to run automated UC-001 tests.
- [ ] Add missing frontend E2E infrastructure in `ui/` for Playwright if `npm run test:e2e` is not already wired, including config, scripts, and browser setup needed to verify UC-001 through the UI.
- [ ] If `.codex/test-gate.yaml` remains absent, define or document the repository-required frontend gate stages during implementation so final verification has a concrete required-stage target.

## 7. Test Plan
- [ ] Domain/Aggregate/VO tests: add focused Vitest coverage near the calculation model/service for precedence, parentheses, decimals, negative numbers, 10-decimal formatting, invalid syntax, incomplete expressions, and invalid operations.
- [ ] Application Service flow tests: verify the calculate orchestration path requests evaluation only after explicit calculate action, uses the repository interface, stores/returns current-session state as designed, and maps failures to `ERROR` without duplicating domain-rule assertions.
- [ ] Infrastructure/Adapter tests: verify the in-memory repository adapter and UI integration preserve in-memory-only session behavior and do not introduce file/storage/network dependencies.
- [ ] Communication/Transaction tests: record non-applicability for messaging/distributed transaction flows in UC-001 and verify no such infrastructure was introduced.
- [ ] Component/UI tests: cover user-visible calculation flow through the rendered React UI, including one valid operator-precedence case and one invalid/incomplete case.
- [ ] Playwright E2E tests: cover the approved UC-001 browser flow end-to-end with valid-expression success and invalid-expression `ERROR` behavior.

## 8. Verification Plan
- [ ] Build:
  - Command: `cd ui && npm run build`
  - Success criteria: TypeScript compile and Vite production build exit with code `0`.
- [ ] Tests:
  - Command: `cd ui && npm run test`
  - Success criteria: Vitest exits with code `0` and covers the UC-001 domain/application/UI assertions defined in this plan.
  - Note: setup required because `ui/package.json` does not currently define a `test` script.
- [ ] E2E:
  - Command: `cd ui && npm run test:e2e`
  - E2E goal: approved `UC-001` Given/When/Then passes in a supported desktop browser.
  - Success criteria: Playwright exits with code `0`; browser flow confirms valid result, 10-decimal formatting, and `ERROR` handling.
  - Note: setup required because `ui/package.json` does not currently define a `test:e2e` script and no Playwright config is present.
- [ ] Test gate:
  - Baseline: `.codex/test-gate.yaml` required stages must pass.
  - Success criteria: required repository stage list is concrete and every required frontend stage passes.
  - Note: `.codex/test-gate.yaml` is currently missing, so executor must define or confirm the repository gate before final verification.
- [ ] Runtime server verification:
  - Server command: `cd ui && npm run dev -- --host 127.0.0.1 --port 4173`
  - Verification method: open the local Vite app in a desktop browser; enter a valid expression such as `1+(2*3)` and confirm `7`; enter a long-decimal case such as `1/3` and confirm `0.3333333333`; enter an invalid or incomplete expression such as `1+` and confirm `ERROR` after explicit calculate.
  - Success criteria: the browser UI matches the approved UC-001 result rules with no backend dependency.
- [ ] Static analysis:
  - Procedure: run existing frontend linting first; if added Vitest/Playwright/config files require lint coverage, include them in the same lint pass; if ESLint alone does not catch feature-layer boundary regressions, add lightweight frontend lint rules or document a manual architecture boundary review in the executor verification notes.
  - Command: `cd ui && npm run lint`
  - Success criteria: ESLint exits with code `0` and no architecture-boundary or frontend code-quality violations remain.

## 9. Completion Conditions
- Every checkbox is marked `- [x]`.
- Implementation and tests stay inside UC-001 scope and ChangeSet boundaries.
- Build, Tests, E2E, Test gate, Runtime server verification, and Static analysis succeed.
- Verification evidence is recorded in this plan or linked executor verification notes.
- After all checks succeed, move the plan to `docs/plans/completed/UC-001/plan.md` or the repository-approved completed-plan path.

## 10. Verification Results
- Build: not run
- Tests: not run
- E2E: not run
- Test gate: not run; `.codex/test-gate.yaml` missing
- Runtime server verification: not run
- Static analysis: not run

## 11. Verification Failures
- None
