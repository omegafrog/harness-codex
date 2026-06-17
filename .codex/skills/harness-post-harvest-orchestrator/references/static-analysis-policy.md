## Static Analysis Policy

This orchestrator does not install linting directly.

- `$harness-code-planner` must include static-analysis setup or verification tasks in each UC `plan.md`.
- `$harness-code-planner` must include decisions from the UC technical-decision slice and `docs/design/기술결정.md` in each UC `plan.md`.
- `$harness-plan-executor` must invoke `$ddd-architecture-linter` when the targeted UC plan reaches static-analysis setup or verification.
- `$harness-plan-executor` must delegate implementation to `implementation_executor` and may only update the targeted UC `plan.md` for orchestration, verification evidence, and `IMPLEMENTATION_FAILURE` remediation tasks.
- If Semgrep is missing during linter execution, `$ddd-architecture-linter` must request approval and attempt installation according to its own instructions.

