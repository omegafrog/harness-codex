# Architecture

## Purpose
This document defines the implementation boundary for the calculator app feature in this repository. Executors must read this file before adding code.

## Scope
- Defines where calculator feature code may be added.
- Defines dependency direction for the React/Vite UI and Python harness runtime.
- Defines forbidden references and non-goals for this ChangeSet.
- Does not redefine domain models, aggregates, business policies, or use-case flows already approved in `docs/design/**`.

## Repository Areas
| Path | Role |
|---|---|
| `ui/` | React + TypeScript + Vite frontend application |
| `harness_codex/` | Python CLI/runtime for harness workflows |
| `tests/` | Python tests for harness runtime |
| `docs/` | Design, ChangeSet, use-case, and plan artifacts |

## Calculator Feature Target
- Primary implementation target: `ui/`
- Primary runtime surface: browser UI
- Primary verification surface: frontend unit/component tests and browser E2E tests
- Python runtime and harness workflow code are out of scope unless needed only for existing repo integration metadata

## UI Structure Rules
- Place calculator feature code under `ui/src/` in feature-oriented structure.
- Prefer grouping by responsibility inside the calculator feature:
  - presentation/UI components
  - application/orchestration hooks or controllers
  - domain logic/value transformations
  - infrastructure/browser adapters if needed
- Keep expression evaluation domain logic separate from purely visual components.
- Keep repository interface separate from repository implementation.
- Current concrete repository direction for v1: in-memory adapter only.

## Dependency Direction
```text
UI components/presentation -> application orchestration -> domain logic
browser adapters/infrastructure -> application contracts -> domain logic
```

Rules:
- Presentation must not contain calculator business rules.
- Domain logic must not depend on React component code.
- Application orchestration may depend on repository interfaces and domain services, not concrete browser UI components.
- Infrastructure adapters may depend on application contracts and domain logic.
- Do not introduce dependencies from `ui/` feature code into `harness_codex/` runtime code.

## Approved Technical Constraints
- Frontend-only v1 implementation.
- No backend/server implementation for calculator behavior.
- No persistence beyond in-memory page-session state in v1.
- No Redis, messaging, analytics, or history features.
- Manual refresh is the only recovery mechanism after app failure.
- Browser-console error logs only for operational logging.
- Verification gate must include Vitest and Playwright.

## Forbidden Changes
- Do not add backend endpoints or Python runtime behavior for calculator operations.
- Do not add file-backed persistence in v1.
- Do not reintroduce undo, latest-result continuation, account, or history scope.
- Do not move approved domain rules out of domain/service boundaries into UI event handlers.
- Do not modify unrelated docs, runtime workflow behavior, or existing user changes outside approved scope.

## Executor Checklist
- Read approved docs in `docs/design/**`, `docs/use-cases/**`, and `docs/changes/active/CHG-20260507-001.md`.
- Implement calculator behavior in `ui/`.
- Keep repository interface and in-memory adapter separated.
- Add Vitest coverage for domain/application/UI state rules.
- Add Playwright coverage for approved UC flows.
- Verify the browser runtime surface, not just isolated functions.

## Verification Expectations
- Frontend build command must pass.
- Frontend automated tests must pass.
- Browser E2E checks for the approved UC flows must pass.
- Static analysis procedure must be recorded in the plan, even if setup is still required.
