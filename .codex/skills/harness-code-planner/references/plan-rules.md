## Plan Rules

The work-item plan must stay compact and executor-ready. Include only facts that affect implementation, tests, verification, or completion gates.

The work-item plan must include:

- ChangeSet ID, work-item ID/type, slice path, goal, non-goals, and E2E or maintenance verification goal.
- Required inputs as a short present/missing list. Do not expand optional inputs unless they change the plan.
- ChangeSet Before/After delta only when needed to define implementation boundary.
- Architecture constraints, repository settings, approved technical decisions, domain impact, conflict/compatibility facts, assumptions, and risks as concise bullets.
- Domain impact bullets must name only affected domain element, canonical references read, and required compatibility tests.
- Do not leave verifier placeholder literals such as `TBD`, `To be derived`, or `Needs confirmation` anywhere in the plan. If an input document contains a placeholder, describe it as an unresolved placeholder without quoting the literal term.
- Spring project/module initialization task using `spring-initializer` when the repository needs a new Spring Boot baseline or a new module.
- A structural task to use `spring-package-structure` to create or verify the Spring module/package skeleton against `ARCHITECTURE.md` before feature code.
- Implementation checklist using markdown checkboxes. Keep each task one or two lines.
- Matching test tasks. Prefer grouping by behavior over layer when shorter.
- A terse `OWASP Security Review` bullet reserved for the post-planning `security_plan_reviewer` agent. The planner may record known attack-surface facts, but must not invent security decisions.
- Verification tasks for build, tests, E2E or maintenance verification, test gate, runtime server verification, and static analysis. Each task should fit on one line: command plus success criterion.
- When browser-accessible web UI work calls a backend on another origin during local verification, include a task to define and verify the development request path: same-origin proxy or backend CORS configuration for the frontend origin, methods, and request headers.
- Runtime server verification after build/test tasks. Specify local run command and concrete HTTP/API/UI checks when the feature has a runtime surface.
- For a runnable application, include tasks to create or update `scripts/run-app-infra.sh` and `scripts/run-app-server.sh`; add `scripts/check-app-infra.sh` when infrastructure needs readiness probing.
- Treat launcher scripts and local infrastructure files as maintained artifacts; update them when ports, services, dependencies, startup order, profiles, or environment defaults change.
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
- Avoid narrative paragraphs in checklist sections.

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
