---
name: harness-update
description: Update the Harness runtime installed in the current repository to the latest release. Use when the user invokes harness-update or asks to update, upgrade or refresh Harness (하네스 업데이트·업그레이드).
model_tier: execution
---

# Harness Update

Update the Harness runtime installed in the **current repository** and report what changed. This skill is only the entry point: follow [Harness Maintenance](../../../.codex/internal-skills/harness-maintenance/GUIDE.md), which owns the procedure.

Rules:

- The target is the repository the user is working in (`git rev-parse --show-toplevel`), never a parent checkout, another worktree, or the Harness source repository.
- Update only an existing installation (`.codex/harness-lock.json` present). If it is missing, explain that this checkout has no update baseline and ask before installing.
- Run the updater with an explicit `--project`, keep the installed provider(s), and finish with the installed Doctor. Report the updated, added and preserved files and only the diagnostics that run returned.
- Do not start the orchestrator, compose a workflow or create a worktree for an update request. Project-owned files (`.harness/harness.yaml`, `docs/**`, application code) are never replaced.
