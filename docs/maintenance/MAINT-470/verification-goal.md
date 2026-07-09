---
work_item_id: MAINT-470
work_item_type: maintenance
status: draft
---

# MAINT-470. Executor write policy verification goal

## Goal

Verify that normal implementation executor writes cannot modify harness control-plane files and cannot edit source, tests, or build/config/script files outside the active plan implementation boundary.

## Focused checks

- Protected harness control-plane paths such as `.harness/system/**`, `.harness/agents/**`, `.harness/contracts/**`, `.harness/docs/**`, `.harness/workflows/**`, `.codex/**`, and `harness_codex/**` are blocked for non-evolve runs.
- Application source files are allowed only inside `implementationBoundary.source`.
- Test files are allowed only inside `implementationBoundary.tests`.
- Build/config/script files are allowed only when listed under `implementationBoundary.configExceptions`.
- Runtime outputs remain allowed under `.harness/runs/**`, `.harness/state/**`, and the active plan path.
