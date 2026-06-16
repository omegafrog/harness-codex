# Repository Settings

## 1. Repository Summary
- Repository type: Python Codex harness runtime with React + TypeScript + Vite dashboard assets.
- Default Python command: `python3`.
- Python environment: repository-root `venv`.
- Primary runtime package: `harness_codex/`.
- Runtime UI assets live under `harness_codex/runtime/dashboard_assets/`.

## 2. Working Boundaries
- Keep ChangeSet, use-case, maintenance, plan, and execution stages separated.
- Runtime code changes belong in `harness_codex/` only when the task explicitly targets runtime behavior.
- Generated workflow artifacts under `docs/**` are not test fixtures to mutate for green checks unless the task explicitly targets artifact templates or examples.
- Preserve unrelated worktree changes.

## 3. Build And Test Commands
|Area|Command|Notes|
|---|---|---|
|Python tests|`./venv/bin/python3 -m pytest -q -s`|Preferred repo verification command|
|Focused Python tests|`./venv/bin/python3 -m pytest -q -s <path>`|Use for scoped changes before broader verification|
|Runtime CLI|`./venv/bin/python3 -m harness_codex --help`|Use when checking CLI import/runtime wiring|

## 4. Runtime Verification
- For dashboard or UI-server work, verify the served runtime through the actual local server when practical.
- Check both backend response shape and served frontend asset behavior when a dashboard issue is visual.
- Use `.harness/runs/<run-id>/` artifacts as runtime truth for active harness workflow runs.

## 5. Static Analysis Expectation
- Do not invent new static-analysis tools only to satisfy a workflow.
- If a task adds or changes static-analysis setup, document the command and focused verification evidence in the relevant plan or report.

## 6. Scope Rules
- Do not collapse requirements, use cases, ChangeSet planning, execution, and verification into one undocumented step.
- Do not remove completion, repo-root, or runtime-state guardrails without targeted tests.
- Keep shell completion, self-update, dashboard session recovery, and `changes continue` routing behavior covered by tests when touched.