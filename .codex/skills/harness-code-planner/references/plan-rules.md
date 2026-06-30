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
- Package taxonomy must be preserved exactly from `ARCHITECTURE.md`, `.codex/repository-settings.md`, or existing module layout. Do not plan new package names by Spring convention. If the module uses `ui/application/domain/infra`, the plan must name those exact packages and must not introduce `controller`, `service`, `presentation`, or `infrastructure` siblings unless the architecture explicitly requires them.
- Implementation checklist using markdown checkboxes. Keep each task one or two lines.
- Matching test tasks. Prefer grouping by behavior over layer when shorter.
- A terse `OWASP Security Review` bullet reserved for the post-planning `security_plan_reviewer` agent. The planner may record known attack-surface facts, but must not invent security decisions.
- Verification tasks for build, tests, E2E or maintenance verification, test gate, runtime server verification, and static analysis. Each task should fit on one line: command plus success criterion.
- Every unchecked verification task must be executable by the implementation executor inside the declared boundary. Do not create unchecked `BLOCKER-*`, approval, scope-recovery, token-acquisition, or user-decision tasks. If such a condition cannot be resolved during planning, the planner must stop with a blocker instead of handing off a plan.
- Before writing `## 집중 검증`, validate every command against the work-item boundary. Do not use root-wide commands that delegate into unrelated modules or create artifacts outside the allowed paths when a focused module/path command can prove the same rule. If a root Gradle task such as `./gradlew architectureRules` delegates to an out-of-scope module, replace it with a focused architecture/static-analysis command such as a module-scoped Gradle task or `semgrep --config <config> <bounded-context>/src/main/java <bounded-context>/src/test/java`, and state the root task is intentionally not used.
- Runtime server verification must be executable in the current environment. When the launcher requires Docker, Compose, a database, broker, or another local infrastructure dependency, include a precondition check command and an explicit environment-blocker rule. If Docker CLI is absent or the daemon is unreachable, the plan must say to record an environment blocker for runtime verification and keep build, focused tests, static analysis, and launcher-script checks as the remaining evidence. Do not require `harness run app` or foreground server commands without that precondition path.
- If a verification command is not applicable, mark it `N/A - <specific reason>` in `## 집중 검증` and provide the strongest bounded replacement evidence. Do not leave unchecked runtime/E2E verification tasks that require unavailable credentials, Docker daemon access, external services, or user approval.
- Before finalizing the plan, compare `affected-files.md`, repository layout, and `ARCHITECTURE.md`. The plan must use the actual package taxonomy and exact paths from the repository. Do not repeat stale affected-files taxonomy such as `controller`, `service`, `presentation`, or `infrastructure` when the repository uses `ui/application/domain/infra`; either derive the correct execution boundary or stop planning if the runtime-declared allowed paths forbid the real files.
- When gateway/authenticated E2E needs credentials that are not available from approved in-scope artifacts, plan a bounded maintenance verification alternative instead of blocking plan approval: focused controller/application tests for the auth boundary behavior, runtime launcher health, and any available gateway unauthenticated/validation checks. Put unavailable full gateway credential flow in notes or follow-up text only, not as an unchecked completion requirement.
- When browser-accessible web UI work calls a backend on another origin during local verification, include a task to define and verify the development request path: same-origin proxy or backend CORS configuration for the frontend origin, methods, and request headers.
- Runtime server verification after build/test tasks. Specify local run command and concrete HTTP/API/UI checks when the feature has a runtime surface.
- For a runnable application, include tasks to create or update `scripts/run-app-infra.sh` and `scripts/run-app-server.sh`; add `scripts/check-app-infra.sh` when infrastructure needs readiness probing.
- Treat launcher scripts and local infrastructure files as maintained artifacts; update them when ports, services, dependencies, startup order, profiles, or environment defaults change.
- Runtime verification must invoke `harness run app` after the script exists. Direct framework commands may support diagnosis but do not replace verification of the maintained launcher contract.
- If there is no runnable server or no server-visible behavior, state runtime server verification is not applicable and explain why.
- Completion evidence requirements that the runtime evaluates before the completion git boundary.

## Checklist Rules

- Use `- [ ]` for pending tasks.
- Prefix every new checklist item with a stable work-item local id such as `TASK-001`, `TEST-001`, or `VERIFY-001`. Keep that id unchanged across plan repair so planner, executor, verifier, and dashboard discuss the same unit.
- Executor must change a completed task to `- [x]` immediately after finishing that task.
- Executor resumes from the first remaining `- [ ]` checkbox. Existing `- [x]` checkboxes are completed state and must not be re-run or rewritten except to diagnose a direct regression blocking a still-unchecked task.
- When updating an existing active plan, do not rewrite, reformat, or normalize the file if no contract-affecting change is required. Preserve the whole plan byte-for-byte, including checkbox markers.
- When a targeted plan repair is required, preserve every unaffected checklist line and every existing `- [x]` marker unless current repository evidence proves that exact task regressed. Do not regenerate the checklist from scratch in a way that resets completed execution state to `- [ ]`.
- If a task must be renamed, split, or merged during plan repair, carry forward the completed state for the same file/verification responsibility and record any new remaining work as a separate `- [ ]` task.
- Keep tasks small enough to verify independently.
- Do not prefix executable checklist ids with `BLOCKER`. Use `TASK`, `TEST`, `VERIFY`, or another action-oriented id. A true blocker belongs in the planner result, not in the executor checklist.
- If Spring baseline initialization or module addition is needed, the first implementation checkbox must instruct the executor to use `spring-initializer` before package-structure work.
- After any needed initialization, include a checkbox instructing the executor to use `spring-package-structure` to create or verify module/package structure and `ARCHITECTURE.md` before adding feature code.
- Include test tasks near the implementation task they verify.
- Put all runnable final verification commands under `## 집중 검증` / `## Focused Verification` or `## 검증 결과` / `## Verification Results`; verifier treats those sections as the plan-side verification authority and ignores implementation checklist wording for command discovery.
- Keep final verification tasks unchecked until the command has succeeded and the result is recorded.
- Avoid narrative paragraphs in checklist sections.

## Completion Evidence Rules

- Keep the plan at `docs/plans/active/<WORK-ITEM-ID>/plan.md` while any checkbox is unchecked.
- Keep the plan active if build, tests, E2E or maintenance verification, runtime server verification, test gate, or static analysis failed or were not run, unless runtime server verification is explicitly marked not applicable with a reason.
- Do not make completion depend on unresolved external approval, token acquisition, or scope-control repair. Convert those into an in-scope verification route during planning, or stop planning as blocked.
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
