---
name: harness-full-workflow
description: Guide a user through the canonical harness runtime command path. Use when the user requests one assisted flow from an idea through ChangeSet execution, but keep all workflow state in the persisted runtime.
---

# Harness Full Workflow

This is a **thin command wrapper**, not a workflow engine and not a state store.
It must not coordinate specialist skills as a parallel orchestration path or
maintain wrapper-owned stage, approval, completion, or resume state.

## Canonical Command Path

```bash
./harness harvest --idea "<request>" --apply --session-id harvest-001
./harness changes create-from-design --title "<title>" --related-issue "#<issue>"
./harness changes active
./harness run-change CHG-YYYYMMDD-001 --apply
```

For intentionally narrow execution:

```bash
./harness run-work-item CHG-YYYYMMDD-001 <WORK-ITEM-ID> --apply
./harness run-use-case CHG-YYYYMMDD-001 <UC-ID> --apply
```

## Rules

1. Read `docs/architecture/canonical-runtime.md` before selecting a command.
2. Use `RunState` at `.harness/runs/<RUN-ID>/state.json` as the sole authority
   for runtime state, gates, blockers, and resume targets.
3. On interruption, show `./harness resume <RUN-ID>` and
   `./harness report <RUN-ID>`; do not reconstruct a next step from chat memory.
4. A harvest question transcript may be used only to continue the harvest CLI
   session. It must not represent implementation completion state.
5. Report the ChangeSet ID, run ID, persisted blocker or completion status, and
   verification evidence returned by the runtime.

Legacy specialist sequencing and wrapper-state instructions are retired. See
`docs/architecture/legacy-command-migration.md` through 2026-09-30.
