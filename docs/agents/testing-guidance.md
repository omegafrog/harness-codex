# Testing and verification guidance

This provider-neutral document stores durable project-specific testing preferences. All linked worktrees read the canonical copy in the original project root supplied as `shared_guidance_root`. Exact launch commands and configuration belong in `docs/agents/EXEC.md` and `docs/agents/execution.json`.

## Active guidance

### run-with-complete-runtime
- Status: active
- Applies to: tests, services, and infrastructure for this project
- Guidance: Start verification only after required infrastructure, application services, launch arguments, environment values, and current configuration have been prepared and verified through the project's execution profile. Do not run with missing infrastructure or stale settings.
- Rationale: The user wants tests to fail closed when runtime prerequisites or configuration are omitted.
- Source: 2026-10-20, user instruction on repeated incomplete test/service startup
- Updated: 2026-10-20

### keep-test-output-in-session
- Status: active
- Applies to: every test and service verification run
- Guidance: Store logs, screenshots, temporary files, and run evidence only under the run's session directory. Preserve every E2E failure and its original evidence until its cause has been addressed and the affected path reverified.
- Rationale: Keep project worktrees clean and prevent failed scenarios from being lost between runs.
- Source: 2026-10-20, user instructions on session output boundaries and learning from E2E failures
- Updated: 2026-10-20

## Superseded guidance
