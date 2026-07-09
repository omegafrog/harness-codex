# Runtime Consolidation

## Goal

Runtime is a local execution platform. It owns local services and durable
artifacts, but it does not own workflow progression, retry, remediation, session
orchestration, or routing decisions.

```text
runtime = local execution platform
orchestration agent = workflow brain
subagent = step executor
gate/verifier = verdict producer
```

## Execution boundary

```text
orchestration agent
  -> selects exactly one ready step
  -> calls SelectedStepRuntimeExecutor.execute_selected_step(...)
  -> runtime executes local step services
  -> runtime returns StepResult only
  -> orchestration agent chooses the next route
```

`SelectedStepRuntimeExecutor` is the runtime API aligned with the #472 target
boundary. It strips dependency-ordering metadata from the selected step because
readiness has already been decided by the orchestration agent. It returns the
step result and never returns the next step.

The former public materialized-workflow/session adapter has been removed from
the public entrypoint. `harness implementation ...` and `harness changes continue
... --apply` now fail closed instead of running runtime-owned ChangeSet session
orchestration.

## Import and bootstrap path

```text
python -m harness_codex
  -> bootstrap.configure_runtime()
  -> install_runtime_services()
  -> entrypoint.main()
  -> canonical_cli.main()
  -> selected-step runtime services for orchestration-agent calls
```

`harness_codex` and `harness_codex.runtime` are import-safe export surfaces.
They do not install extensions, replace CLI functions, start background threads,
run repository patch installers, or mutate runtime callables merely because an
application imports them.

## Responsibility boundary

| Responsibility | Owner |
|---|---|
| workflow progression | orchestration agent |
| ChangeSet session orchestration | orchestration agent |
| step selection | orchestration agent |
| failed/blocked routing | orchestration agent |
| retry/remediation decision | orchestration agent |
| subagent selection | orchestration agent |
| one selected step execution | selected-step runtime service / subagent boundary |
| step ledger write | runtime service |
| worktree setup | runtime service |
| artifact directories | runtime service |
| dashboard projection/UI | runtime service |
| XML schema validation | runtime service |
| static gate execution | runtime service |
| memory/observability/shell/server lifecycle | runtime service |

`RunnerEngine` remains an internal local execution helper for one-step runtime
execution and low-level tests. It blocks `StepKind.DECISION` before invoking the
step runner. `LocalStepRunner` also refuses decision steps before delegating to
the lower-level `BasicStepRunner` adapter. Decision steps are reported as
orchestration-agent-owned blockers instead of being executed by runtime.

## Runtime installer contract

`bootstrap.configure_runtime()` is a single explicit installer entrypoint. It
calls `install_runtime_services(...)` and returns the installation result.

Allowed installer duties:

- prepare runtime-owned directories;
- register schema contracts;
- register static gate conditions;
- register local tools;
- prepare dashboard/runtime service manifests.

Forbidden installer duties:

- import-time side effects;
- `apply_xxx_patch()` calls;
- monkey patching;
- replacing existing callables;
- CLI function reassignment;
- repository patch runner execution.

## Runtime service registry

The default registry exposes these local service tools without making routing
decisions:

- `selected-step-execution`
- `worktree-setup`
- `artifact-directories`
- `dashboard-projection`
- `dashboard-ui`
- `memory`
- `observability`
- `shell-command`
- `dev-server-lifecycle`
- `deploy-server-lifecycle`

Each registered tool returns service capability data unless a concrete handler
is explicitly bound by runtime composition. Tool calls return structured data,
not next-step decisions.

## Gate and verifier contract

Gate and verifier output is verdict-only. It may include:

- `pass`, `fail`, or `blocked` status;
- rule id;
- reason;
- evidence path;
- violation list.

Gate and verifier output must not include these fields at any nested level:

- next step;
- planner/executor/verifier owner decision;
- owner stage;
- recommended resume target;
- retry target;
- remediation route.

## Completed consolidation

| Area | Result |
|---|---|
| Bootstrap composition | Single installer entrypoint; no compatibility patch registry. |
| Repository update | Self-update and install script no longer run a repository patch installer. |
| Runtime patch modules | Compatibility patch modules have been removed from the runtime package. |
| Public entrypoint | Direct implementation/session orchestration dispatch removed. |
| Public CLI | Runtime-owned `implementation` and `changes continue` execution fail closed. |
| Session coordinator | Replaced with a selected-step runtime facade; no ChangeSet session run loop remains there. |
| SelectedStepRuntimeExecutor | Preferred runtime API executes exactly one orchestration-agent-selected step and returns only `StepResult`. |
| RunnerEngine | Internal local execution helper; blocks decision steps and does not retry/remediate/route failures. |
| LocalStepRunner | Runtime runner boundary delegates local execution but refuses workflow decision steps. |
| Static workflow | Failure-router step removed from the ChangeSet work-item execution workflow. |
| Verification | XML verifier emits verdict-only reports, writes non-implementation blockers as `blocked`, and rejects routing-shaped reports recursively. |
| Dashboard projection | Dashboard rows expose verdict classification only, not owner/resume routing fields. |
| Orchestration contract | `OrchestrationAgent` owns progression/routing/retry/remediation; `SubagentExecutor` runs exactly one selected step. |
| Runtime services | Schema/gate interfaces and runtime-owned local service tools are explicit service interfaces. |

## Verification

Run the focused regression suite before merge:

```bash
python3 -m py_compile \
  harness_codex/bootstrap.py \
  harness_codex/canonical_cli.py \
  harness_codex/entrypoint.py \
  harness_codex/runtime/dashboard.py \
  harness_codex/runtime/engine.py \
  harness_codex/runtime/local_step_runner.py \
  harness_codex/runtime/orchestration_contract.py \
  harness_codex/runtime/runtime_services.py \
  harness_codex/runtime/selected_step_runtime.py \
  harness_codex/runtime/session_coordinator.py \
  harness_codex/runtime/self_update.py \
  harness_codex/runtime/state_projection.py \
  harness_codex/runtime/verification_failure.py \
  harness_codex/runtime/structured_verify_work_item_xml.py \
  tests/test_engine_runtime_integration.py \
  tests/test_local_step_runner.py \
  tests/test_orchestration_contract.py \
  tests/test_runtime_bootstrap.py \
  tests/test_runtime_services.py \
  tests/test_selected_step_runtime.py \
  tests/test_self_update.py \
  tests/test_state_projection.py \
  tests/test_token_observability.py \
  tests/test_verification_xml_contract.py \
  tests/test_workflow_orchestrator_failure_router.py

python3 -m pytest -q \
  tests/test_engine_runtime_integration.py \
  tests/test_local_step_runner.py \
  tests/test_orchestration_contract.py \
  tests/test_runtime_bootstrap.py \
  tests/test_runtime_services.py \
  tests/test_selected_step_runtime.py \
  tests/test_self_update.py \
  tests/test_state_projection.py \
  tests/test_token_observability.py \
  tests/test_verification_xml_contract.py \
  tests/test_workflow_orchestrator_failure_router.py
```

## Guardrails

- Runtime imports must not mutate runtime callables.
- Runtime must not expose public ChangeSet session orchestration.
- Runtime-owned implementation and changes-continue execution must fail closed.
- Runtime must not execute workflow decision steps.
- Verifier/gate reports must remain verdict-only.
- The installer must remain a service installer, not a patch registry.
- Repository update must not run migration patch files.
- Any new local service belongs behind an explicit runtime service interface.
- New orchestration integrations must call selected-step execution instead of adding workflow-brain logic to runtime.
