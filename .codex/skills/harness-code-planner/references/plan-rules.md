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
- Before writing `## 집중 검증`, discover the repository's actual verification capabilities from build files, scripts, `.codex/test-gate.yaml`, repository settings, and existing CI/test conventions. Do not invent architecture, lint, E2E, or launcher commands that the repository does not expose.
- Validate every command against the work-item boundary. Do not use root-wide commands that delegate into unrelated modules or create artifacts outside the allowed paths when a focused module/path command can prove the same rule. For any non-standard root Gradle verification task, either use a module-qualified task, provide a path-scoped static-analysis command, mark the root task not applicable with a reason, or document why that repository capability is work-item scoped.
- Runtime server verification must be executable in the current environment. When the launcher requires Docker, Compose, a database, broker, or another local infrastructure dependency, include a precondition check command and an explicit environment-blocker rule. If Docker CLI is absent or the daemon is unreachable, the plan must say to record an environment blocker for runtime verification and keep build, focused tests, static analysis, and launcher-script checks as the remaining evidence. Do not require `harness run app` or foreground server commands without that precondition path.
- If a verification command is not applicable, mark it `N/A - <specific reason>` in `## 집중 검증` and provide the strongest bounded replacement evidence. Do not leave unchecked runtime/E2E verification tasks that require unavailable credentials, Docker daemon access, external services, or user approval.
- Before finalizing the plan, compare repository layout, `ARCHITECTURE.md`, and the ChangeSet included/excluded scope. The plan must use the actual package taxonomy and exact paths from the repository. Do not repeat stale taxonomy such as `controller`, `service`, `presentation`, or `infrastructure` when the repository uses `ui/application/domain/infra`.
- Do not include runtime control files, agent context, read-only context, review artifacts, verification-tool configuration, generated reports, `.harness/docs/**` harness documentation/templates, or unrelated module outputs in the executor write boundary. Valid implementation write paths are product source files, tests, directly required build files, and maintained execution scripts. If verification mentions a tool config such as `.semgrep/**`, treat it as read-only verification input unless the ChangeSet explicitly requests tooling changes.
- When gateway/authenticated E2E needs credentials that are not available from approved in-scope artifacts, plan a bounded maintenance verification alternative instead of blocking plan approval: focused controller/application tests for the auth boundary behavior, runtime launcher health, and any available gateway unauthenticated/validation checks. Put unavailable full gateway credential flow in notes or follow-up text only, not as an unchecked completion requirement.
- When browser-accessible web UI work calls a backend on another origin during local verification, include a task to define and verify the development request path: same-origin proxy or backend CORS configuration for the frontend origin, methods, and request headers.
- Runtime server verification after build/test tasks. Specify local run command and concrete HTTP/API/UI checks when the feature has a runtime surface.
- When a work item creates a new runnable server, adds a new runtime entrypoint, adds or changes Docker/Compose services, or changes maintained app launcher behavior, include CI coverage tasks. The plan must create or update `.github/workflows/**` so CI runs the bounded build/test commands and, when local infrastructure is required, either a bounded smoke check or an explicit documented reason why CI cannot run that runtime check. If the repository has no GitHub Actions setup, mark CI workflow coverage `N/A - <specific reason>` and include the strongest local replacement verification.
- For a runnable application, include tasks to create or update the development runtime lifecycle scripts `scripts/app/dev/build-images.sh`, `scripts/app/dev/start.sh`, `scripts/app/dev/stop.sh`, `scripts/app/dev/health.sh`, and `scripts/app/dev/logs.sh`. Development runtime must run all local servers and infrastructure through Docker, and every runnable build artifact must have a Docker image definition rather than relying on a host framework command.
- For harness compatibility, include tasks to keep `scripts/run-app.sh`, `scripts/run-app-infra.sh`, `scripts/run-app-server.sh`, `scripts/run-app-logs.sh`, and `scripts/check-app-infra.sh` as development wrappers around the maintained `scripts/app/dev/*` scripts.
- For production runtime, first search for the repository-local production operations Markdown supplied by the user, such as `docs/operations/production-runtime.md`, `docs/ops/production-runtime.md`, `docs/deployment/production.md`, or another clearly named production/deployment `.md`. If present, include tasks to create or update `scripts/app/prod/build-images.sh`, `scripts/app/prod/start.sh`, `scripts/app/prod/stop.sh`, `scripts/app/prod/health.sh`, and `scripts/app/prod/logs.sh` according to that document. If absent, state production runtime script generation is blocked for lack of production operations input; do not guess cloud provider, cluster, registry, account, region, namespace, or teardown semantics.
- Include secret/config templates for every required runtime value, such as `config/runtime/dev.env.template` and `config/runtime/prod.env.template`. Templates must contain placeholder keys and comments only; plans must forbid committing real secrets. Runtime scripts must load developer-provided env files derived from those templates and fail with a clear message when a required env file or value is absent.
- Treat launcher scripts, Dockerfiles, Compose files, env templates, and local/production infrastructure scripts as maintained artifacts; update them when ports, services, dependencies, startup order, profiles, health endpoints, registries, namespaces, or environment defaults change.
- Development Docker/Compose services must carry discoverable labels for UI log collection, including `harness.runtime=dev` and a repository/project label matching the repository name or Compose project.
- Every runtime environment script set must provide start, stop, health, and per-service logs behavior. Logs scripts must accept `list` to print available log targets and `<service>` to print only that service/container's logs through `docker logs` or `docker compose logs`; unknown service names must fail non-zero. Stop scripts must verify that all containers and infrastructure owned by that environment are down; production stop scripts must also verify cloud containers/services/tasks/pods/jobs are stopped or removed using the commands approved in the production operations Markdown.
- Runtime verification must invoke `harness run app` after the development wrapper exists. Direct framework commands may support diagnosis but do not replace verification of the maintained launcher contract.
- If there is no runnable server or no server-visible behavior, state runtime server verification is not applicable and explain why.
- Completion evidence requirements that the runtime evaluates before the completion git boundary.

## Checklist Rules

- Use `- [ ]` for pending tasks.
- Prefix every new checklist item with a stable work-item local id such as `TASK-001`, `TEST-001`, or `VERIFY-001`. Keep that id unchanged across plan repair so planner, executor, verifier, and dashboard discuss the same unit.
- Executor must not edit active-plan checkbox markers. Runtime execution results belong in `execution-report.json`.
- Executor uses the plan checklist as instructions and reports completed/remaining tasks in `execution-report.json`.
- When updating an existing active plan, do not rewrite, reformat, or normalize the file if no contract-affecting change is required. Preserve the whole plan byte-for-byte.
- When a plan rewrite or targeted repair is required, treat the active plan as a fresh executor input for the current run. Remove checklist items that are already complete and do not need more work. Keep only work that the next executor must perform.
- If a completed item needs more work after new evidence, rewrite that item as a current-run task and mark it `- [ ]`. Do not keep it checked merely because an older run completed an earlier version.
- Do not carry prior `- [x]` execution state into a rewritten active plan. Checked items are valid only when the current active plan is intentionally preserving an unchanged no-op state.
- Keep tasks small enough to verify independently.
- Do not prefix executable checklist ids with `BLOCKER`. Use `TASK`, `TEST`, `VERIFY`, or another action-oriented id. A true blocker belongs in the planner result, not in the executor checklist.
- If Spring baseline initialization or module addition is needed, the first implementation checkbox must instruct the executor to use `spring-initializer` before package-structure work.
- After any needed initialization, include a checkbox instructing the executor to use `spring-package-structure` to create or verify module/package structure and `ARCHITECTURE.md` before adding feature code.
- Include test tasks near the implementation task they verify.
- Put all runnable final verification commands under `## 집중 검증` / `## Focused Verification`; verifier treats that section as the plan-side verification command authority and ignores implementation checklist wording for command discovery.
- Do not put prior execution evidence paths in the active plan. Execution evidence belongs in runtime evidence files and `execution-report.json`.
- When rewriting a stale active plan, clear stale verification results back to pending, `N/A - <reason>`, or current-run instructions. Do not copy old PASS evidence into `## 검증 결과`.
- Avoid narrative paragraphs in checklist sections.

## Completion Evidence Rules

- Keep the plan at `docs/plans/active/<WORK-ITEM-ID>/plan.md` until `complete-work-item-plan` verifies a matching `execution-report.json`.
- Keep the plan active if `execution-report.json` is missing, stale, incomplete, failed, or references missing evidence.
- Do not make completion depend on unresolved external approval, token acquisition, or scope-control repair. Convert those into an in-scope verification route during planning, or stop planning as blocked.
- The planner must leave the plan at the active path even after its evidence is complete.
- `complete-work-item-plan` is the sole owner of the active-to-completed transition and may run only when:
  - `execution-report.json` references the current plan fingerprint
  - tests required by the plan exist
  - build succeeded
  - tests succeeded
  - E2E or maintenance verification succeeded when applicable
  - `.codex/test-gate.yaml` required stages passed
  - runtime server verification succeeded or is explicitly not applicable with a reason
  - static analysis succeeded
  - verification results and evidence paths are recorded in `execution-report.json`
- Integrated docs and canonical domain docs should be synced by docs-sync/doc-verify before completing the ChangeSet. This planner records the need but does not perform that sync.
