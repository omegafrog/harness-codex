# Implementation Executor Performance Remediation Plan

## Status

- Plan type: standalone remediation plan
- Formal ChangeSet plan: blocked because no active ChangeSet or maintenance work item exists
- Target repository: `harness`
- Primary runtime surface: implementation-stage agent execution

## Problem

One implementation workflow required six `implementation_executor` sessions and about 217 minutes of active executor time. Two sessions terminated near the historical one-hour timeout. Each retry started a fresh Codex session, repeated repository analysis and browser verification, and repaired evidence that did not match the deterministic verifier contract.

Measured impact:

- Six executor sessions
- About 6.8 million model tokens
- Repeated Spring Boot, Vite, and browser E2E startup
- No product-code edits during the measured retries
- Completion delayed by timeout, lost progress, and evidence reconciliation

## Goal

Make implementation retries continue from durable progress instead of repeating completed analysis and verification.

Success criteria:

- A timed-out implementation step can continue using its previous Codex session when supported.
- Completed commands and verification evidence survive timeout and process termination.
- A retry skips unchanged, already-passed verification phases.
- Runtime-generated evidence satisfies `verify_work_item.py` without agent-authored format repair.
- Existing fresh-run behavior remains available when resume state is absent or invalid.

## Non-Goals

- Changing requirements, use-case, DDD, or planning workflow boundaries.
- Removing deterministic completion or test-gate checks.
- Treating a longer timeout as the primary solution.
- Reusing verification after relevant source, configuration, command, or E2E-goal changes.
- Caching failed or incomplete browser verification.

## Scope

Primary files:

- `harness_codex/runtime/runner.py`
- `harness_codex/runtime/state.py`
- `harness_codex/runtime/models.py`
- `harness_codex/runtime/verify_work_item.py`
- `harness_codex/runtime/reports.py`
- `harness_codex/cli.py`
- `.codex/agents/references/implementation_executor.md`
- `.codex/skills/harness-plan-executor/references/detailed-instructions.md`

Primary tests:

- `tests/runtime/test_agent_runner.py`
- `tests/runtime/test_run_state_resume.py`
- `tests/runtime/test_verify_work_item.py`
- `tests/runtime/test_verifier_contract.py`
- `tests/runtime/test_procedure_stage_runtime.py`
- `tests/test_cli_commands.py`
- `tests/test_plan_executor_use_case_loop.py`

## Technical Approach

### Phase 1: Resumable Agent Execution

- [ ] Inspect locally installed `codex exec` resume capabilities and define a provider-neutral resume contract.
- [ ] Extend agent result metadata with provider session ID, resume eligibility, attempt number, and termination reason.
- [ ] Persist provider session metadata under the implementation step run directory before returning step status.
- [ ] On implementation retry, locate the latest compatible failed or timed-out attempt for the same ChangeSet, work item, agent, and repository.
- [ ] Resume the prior Codex session when metadata is valid.
- [ ] Fall back to a fresh session when resume is unsupported, missing, corrupt, or explicitly disabled.
- [ ] Prevent resume across different repositories, ChangeSets, work items, agents, or incompatible prompt contracts.
- [ ] Report `fresh` versus `resumed` execution in CLI output and run reports.

### Phase 2: Durable Phase Checkpoints

- [ ] Add implementation checkpoint schema containing phase, completed task IDs, executed commands, results, evidence paths, relevant hashes, and remaining actions.
- [ ] Store checkpoints atomically under `.harness/runs/<run-id>/steps/<step-id>/`.
- [ ] Update checkpoint after focused tests, build, runtime startup, browser E2E, and artifact closure.
- [ ] Include checkpoint summary in resumed prompts.
- [ ] Treat checkpoint as execution evidence, not authority to bypass current verifier checks.
- [ ] Ignore checkpoints with unsupported schema versions or mismatched scope hashes.

### Phase 3: Runtime-Owned Verification Evidence

- [ ] Capture every executed verification command, exit code, duration, and output artifact path as structured data.
- [ ] Map structured command results to plan verification obligations and `.codex/test-gate.yaml`.
- [ ] Generate verifier-compatible evidence from structured command results.
- [ ] Remove need for the executor to reproduce evidence syntax manually.
- [ ] Keep the verifier authoritative: incomplete mappings remain blocking.
- [ ] Record clear diagnostics for unmatched obligations and stale evidence.

### Phase 4: Verification-Only Retry Mode

- [ ] Compute hashes for implementation scope, plan obligations, E2E goal, test-gate configuration, and runtime configuration.
- [ ] Detect retries where product implementation is already present and no relevant implementation hash changed.
- [ ] Enter verification-only mode instead of repeating broad product-code analysis.
- [ ] Skip passed focused phases whose command and input hashes still match.
- [ ] Re-run failed, incomplete, stale, or environment-sensitive phases.
- [ ] Always re-run deterministic final completion and scope-diff checks.

### Phase 5: Browser E2E Reuse

- [ ] Persist successful browser scenario evidence with source, frontend, backend, E2E-goal, command, and runtime configuration hashes.
- [ ] Reuse browser evidence only when all hashes match and required artifacts remain available.
- [ ] Invalidate evidence after relevant source/configuration changes or changed acceptance criteria.
- [ ] Keep an explicit force-rerun option for diagnosis and release validation.

## Test Plan

### Unit Tests

- [ ] Timed-out agent result persists provider session ID and checkpoint metadata.
- [ ] Compatible retry selects resume command.
- [ ] Missing or invalid session metadata selects fresh command.
- [ ] Scope mismatch prevents session reuse.
- [ ] Checkpoint writes are atomic and malformed checkpoints are ignored safely.
- [ ] Evidence mapper accepts successful matching commands and rejects missing obligations.
- [ ] Verification-only mode invalidates correctly after source, plan, E2E, or configuration changes.

### Runtime Integration Tests

- [ ] Simulate timeout after successful focused tests; retry resumes and does not repeat focused tests.
- [ ] Simulate timeout after browser success; retry performs artifact closure without browser replay.
- [ ] Simulate failed browser check; retry reruns browser phase.
- [ ] Verify fresh retry remains functional when provider resume is unavailable.
- [ ] Verify implementation completion still blocks on unchecked tasks, failed test gate, missing evidence, or scope violations.
- [ ] Verify run report exposes attempt history, resume state, checkpoint phase, and reused evidence.

### Regression Tests

- [ ] `./venv/bin/python3 -m pytest -q -s tests/runtime/test_agent_runner.py`
- [ ] `./venv/bin/python3 -m pytest -q -s tests/runtime/test_run_state_resume.py`
- [ ] `./venv/bin/python3 -m pytest -q -s tests/runtime/test_verify_work_item.py tests/runtime/test_verifier_contract.py`
- [ ] `./venv/bin/python3 -m pytest -q -s tests/runtime/test_procedure_stage_runtime.py tests/test_cli_commands.py`
- [ ] `./venv/bin/python3 -m pytest -q -s tests/test_plan_executor_use_case_loop.py`
- [ ] `./venv/bin/python3 -m pytest -q -s`

## Runtime Verification

- [ ] Create a fixture ChangeSet with one implementation work item and deterministic slow executor behavior.
- [ ] Start implementation and force termination after a completed verification phase.
- [ ] Continue the same ChangeSet.
- [ ] Confirm CLI reports resumed execution.
- [ ] Confirm completed phase command is not repeated.
- [ ] Confirm final verifier and test gate still execute and pass.
- [ ] Confirm run artifacts contain attempt history, checkpoint, structured evidence, and final report.

## Static Analysis

- [ ] Run existing repository lint or static-analysis command when defined.
- [ ] Run `./venv/bin/python3 -m compileall -q harness_codex`.
- [ ] Confirm new persisted JSON uses typed parsing and schema-version validation.

## Rollout

1. Ship Phase 1 behind a default-on provider capability check.
2. Ship Phase 2 before enabling phase skipping.
3. Enable runtime-owned evidence after parity tests against current verifier behavior.
4. Enable verification-only mode with explicit report diagnostics.
5. Enable browser evidence reuse last, initially opt-in.

Rollback:

- Disable resume and reuse through configuration.
- Preserve fresh execution path.
- Ignore checkpoint/cache artifacts without deleting them.
- Keep deterministic verifier and test gate unchanged.

## Risks

- Resuming an incompatible session could apply stale assumptions.
  Mitigation: strict repository, ChangeSet, work-item, agent, prompt-contract, and schema hashes.
- Reused evidence could hide regressions.
  Mitigation: conservative invalidation and mandatory final deterministic checks.
- Checkpoint corruption could block execution.
  Mitigation: atomic writes, versioned schema, and fresh-run fallback.
- Provider-specific session behavior could leak into runtime orchestration.
  Mitigation: provider-neutral resume metadata and capability interface.

## Recommended Delivery Slices

1. `MAINT-IMPLEMENTATION-RESUME`: provider session persistence, compatible resume, attempt reporting.
2. `MAINT-IMPLEMENTATION-CHECKPOINT`: durable phases and retry prompt summary.
3. `MAINT-VERIFICATION-EVIDENCE`: structured command capture and verifier mapping.
4. `MAINT-VERIFICATION-REUSE`: verification-only mode and conservative E2E reuse.

## Formal Planning Prerequisite

Before implementation, create an active maintenance ChangeSet and one maintenance slice for the first delivery item. Then move the selected slice into:

`docs/plans/active/<MAINT-ID>/plan.md`

Run security plan review and artifact review before executor use.
