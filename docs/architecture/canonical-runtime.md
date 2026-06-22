# Canonical Runtime Workflow

## Authority

`RunnerEngine` executes the workflow. The persisted run record at
`.harness/runs/<RUN-ID>/state.json` (`RunState`) is the authoritative state for
execution, resumption, gate results, artifact acceptance, downstream dirtiness,
and failure status.

A ChangeSet describes the requested scope; it does not replace `RunState` as
execution state. Skill wrappers, chat summaries, dashboard sessions, and
harvest question transcripts are convenience context only. They must never
override a persisted `RunState` decision.

## Official Command Path

Use this sequence for every new change:

```bash
# 1. Harvest or refresh project-level design.
./harness harvest --idea "<product or change request>" --apply --session-id harvest-001

# 2. Create the scoped ChangeSet from the resulting design.
./harness changes create-from-design \
  --title "<change title>" \
  --related-issue "#378"

# 3. Inspect readiness and select execution scope.
./harness changes active
./harness run-change CHG-YYYYMMDD-001 --plan

# 4. Execute all work items or a deliberately narrow item.
./harness run-change CHG-YYYYMMDD-001 --apply
./harness run-work-item CHG-YYYYMMDD-001 MAINT-001 --apply
./harness run-use-case CHG-YYYYMMDD-001 UC-001 --apply

# 5. Resume and inspect persisted runtime evidence.
./harness resume run-<id>
./harness report run-<id>
```

`run-change` executes every ready work item in the ChangeSet. `run-work-item`
is the general narrow-scope command. `run-use-case` is only a convenience alias
for a `use_case` work item.

## State Ownership

| Concern | Owner | Non-authoritative helpers |
| --- | --- | --- |
| Change intent and affected work items | active ChangeSet | README and planning notes |
| Materialized workflow and per-step result | `RunnerEngine` | skill instructions |
| Resume target, gate status, artifacts, and blockers | `RunState` | wrapper/session notes and dashboard cache |
| Human-readable evidence | run report | terminal output |

When a helper disagrees with `RunState`, inspect the persisted state and report
rather than attempting to repair state from the helper.

## Bootstrap Output Policy

Bootstrap creates only compact, reusable agent context:

- `AGENTS.md`
- `docs/agent/context.md`
- `docs/agent/commands.md`
- `docs/agent/codebase-artifacts.md`

The following are diagnostics or ephemeral handoff material, not required
workflow inputs: `docs/agent/session-state.md`,
`docs/agent/design-conformance-report.md`, and
`docs/agent/token-reduction-report.md`. Do not add a gate, prompt dependency,
or dashboard dependency on them. Generate them only through an explicit
analysis/report command when that capability is needed.

## Wiki Bootstrap Policy

`harness run wiki` must distinguish two operations:

1. **Initial bootstrap**: create the repository wiki contract only when it is
   missing.
2. **Incremental update**: preserve existing project-written pages and update
   only generated index/navigation or explicitly selected workflow pages.

A routine runtime execution must never overwrite a project wiki as though it
were a first bootstrap.

## Compatibility Window

The procedure-stage commands and `ultrawork` are replaced by the official path
above. Their compatibility documentation remains until **2026-09-30**. New
code, skills, README examples, and shell completion must not advertise them.
See `docs/architecture/legacy-command-migration.md` for exact replacements.
