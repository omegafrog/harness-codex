## Plan Rules

The work-item plan must include:

- Implementation goal for the selected ChangeSet work item.
- Explicit non-goals: what must not be implemented.
- ChangeSet ID, work-item ID, work-item type, and work-item slice path.
- Input document table, including present/missing/optional status.
- ChangeSet Before/After delta and implementation scope boundary.
- E2E goal for use-case work items or verification goal for maintenance work items.
- Architecture constraints from `ARCHITECTURE.md`.
- Repository settings from `.codex/repository-settings.md`.
- Approved technical decisions and how each maps to implementation, tests, and verification.
- Domain impact:
  - reused existing aggregate/entity/value object/domain service/port
  - new domain element to create
  - existing domain element to modify
  - canonical domain reference files read
  - compatibility tests for existing use cases that share the domain element
- Whether another active ChangeSet modifies the same canonical domain element.
- Scope assumptions and unresolved risks.
- Spring project/module initialization task using `spring-initializer` when the repository needs a new Spring Boot baseline or a new module.
- A structural task to use `spring-package-structure` to create or verify the Spring module/package skeleton against `ARCHITECTURE.md` before feature code.
- Implementation checklist using markdown checkboxes.
- Matching test tasks.
- An `OWASP Security Review` section reserved for the post-planning `security_plan_reviewer` agent. The planner may record known attack-surface facts, but must not invent security decisions.
- Verification tasks for build, tests, E2E or maintenance verification, test gate, runtime server verification, and static analysis.
- When browser-accessible web UI work calls a backend on another origin during local verification, include a task to define and verify the development request path: same-origin proxy or backend CORS configuration for the frontend origin, methods, and request headers.
- Runtime server verification after build/test tasks. The plan must specify the local run command, usually `./gradlew bootRun` or the repository's existing command, and concrete behavior checks through HTTP/API/UI when the feature has a runtime surface.
- For a runnable application, include tasks to create or update versioned `scripts/run-app-infra.sh` and `scripts/run-app-server.sh` contracts. Add `scripts/check-app-infra.sh` when infrastructure needs an explicit readiness probe. The scripts must start the complete local application from the repository root, including required infrastructure through code such as `compose.yaml`, Dockerfiles, migrations, or seed/bootstrap scripts.
- Treat component launcher scripts and their referenced local infrastructure files as maintained production artifacts. Keep component commands foreground for tmux lifecycle management. Update them whenever implementation changes ports, services, dependencies, startup order, profiles, or required environment defaults.
- Runtime verification must invoke `harness run app` after the script exists. Direct framework commands may support diagnosis but do not replace verification of the maintained launcher contract.
- If there is no runnable server or no server-visible behavior, state runtime server verification is not applicable and explain why.
- Completion evidence requirements that the runtime evaluates before the completion git boundary.

## Checklist Rules

- Use `- [ ]` for pending tasks.
- Executor must change a completed task to `- [x]` immediately after finishing that task.
- Keep tasks small enough to verify independently.
- If Spring baseline initialization or module addition is needed, the first implementation checkbox must instruct the executor to use `spring-initializer` before package-structure work.
- After any needed initialization, include a checkbox instructing the executor to use `spring-package-structure` to create or verify module/package structure and `ARCHITECTURE.md` before adding feature code.
- Include test tasks near the implementation task they verify.
- Keep final verification tasks unchecked until the command has succeeded and the result is recorded.

## Completion Evidence Rules

- Keep the plan at `docs/plans/active/<WORK-ITEM-ID>/plan.md` while any checkbox is unchecked.
- Keep the plan active if build, tests, E2E or maintenance verification, runtime server verification, test gate, or static analysis failed or were not run, unless runtime server verification is explicitly marked not applicable with a reason.
- The planner must leave the plan at the active path even after its evidence is complete.
- `complete-work-item-plan` is the sole owner of the active-to-completed transition and may run only when:
  - every checkbox is checked
  - tests required by the plan exist
  - build succeeded
  - tests succeeded
  - E2E or maintenance verification succeeded when applicable
  - `.codex/test-gate.yaml` required stages passed
  - runtime server verification succeeded or is explicitly not applicable with a reason
  - static analysis succeeded
  - verification results are recorded in the plan
- Integrated docs and canonical domain docs should be synced by docs-sync/doc-verify before completing the ChangeSet. This planner records the need but does not perform that sync.
