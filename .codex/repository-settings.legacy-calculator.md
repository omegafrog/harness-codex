# Legacy Repository Settings

This file preserves the previous calculator-specific repository settings that were removed from the active repository-wide settings during harness diet cleanup.

# Repository Settings

## 1. Repository Summary
- Repository type: Python harness runtime with React + TypeScript + Vite UI
- Primary feature target for ChangeSet `CHG-20260507-001`: `ui/`
- Default Python command: `python3`
- Python environment: repository-root `venv`

## 2. Working Boundaries
- UI feature implementation belongs in `ui/`
- Harness runtime code in `harness_codex/` is out of scope for calculator behavior
- Tests for calculator feature should focus on frontend behavior unless ChangeSet scope explicitly expands

## 3. Build And Test Commands
|Area|Command|Notes|
|---|---|---|
|UI install|`cd ui && npm install`|Run only if dependencies are missing|
|UI build|`cd ui && npm run build`|Required verification gate|
|UI unit/component tests|`cd ui && npm run test`|Expected Vitest command; adjust if script differs|
|UI E2E tests|`cd ui && npm run test:e2e`|Expected Playwright command; add script/setup if missing|
|Python tests|`./venv/bin/python3 -m pytest -q -s`|Use only if ChangeSet scope touches Python runtime or repo-level verification requires it|

## 4. Runtime Verification
- Frontend dev server command: `cd ui && npm run dev -- --host 127.0.0.1 --port 4173`
- Browser verification target: local Vite app

## 5. Static Analysis Expectation
- If frontend lint/static-analysis scripts already exist, use them.
- If they do not exist, planner/executor must record setup-required status and add a suitable verification step without inventing unrelated backend tooling.

## 6. Scope Rules
- Do not introduce backend/server, persistence, messaging, analytics, or history features for the calculator app in v1.
- Keep repository interface and in-memory adapter separated.
- Keep approved domain rules aligned with `docs/design/**`.
