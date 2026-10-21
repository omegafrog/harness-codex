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

### selective-e2e-and-dynamic-agent-oracles
- Status: active
- Applies to: test planning, implementation verification, and E2E runner handoffs
- Guidance: Default to focused unit/integration/contract checks. Use E2E only on explicit request or a changed critical cross-boundary path that cheaper checks cannot establish. For dynamic agent services, verify stable transport/UI states and goal/state/tool/permission/persistence/side-effect evidence; do not assert exact prose, ordering, or counts without a canonical contract. Keep E2E attempts bounded and do not let a runner edit tests or source.
- Rationale: Avoid repeated slow E2E runs against intentionally dynamic agent responses and prevent retry-driven expectation weakening.
- Source: 2026-10-21, explicit user preference on unnecessary E2E execution and dynamic agent response assertions
- Updated: 2026-10-21

## Superseded guidance
