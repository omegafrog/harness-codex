---
name: harness-maintenance
description: Update the project-local Harness runtime when the user asks to update, upgrade, or refresh Harness; do not use for application dependency updates.
---

# Harness Maintenance

Use this skill for requests such as “하네스 업데이트해”, “Harness 업그레이드해”, or “refresh the Harness runtime”. The target is the Harness runtime in the current consumer repository, not the application’s package dependencies.

1. Resolve the current repository root with `git rev-parse --show-toplevel`. Do not update a parent checkout, another worktree, or the Harness source repository by assumption.
2. Check that `.codex/harness-lock.json` exists at that root. If it is absent, explain that this checkout is not installed or has no update baseline; do not substitute installation for an update request without the user's direction.
3. Run the update from any directory with the explicit target:

   ```bash
   npx --yes github:omegafrog/harness-codex update --project <repository-root>
   ```

4. Run the installed version's diagnostic command:

   ```bash
   npx --yes --package github:omegafrog/harness-codex harness-codex-doctor --project <repository-root>
   ```

5. Report updated and added files, any `Preserved` files, and the diagnostic result. Never run `harness-codex lock` for preserved files automatically: it accepts the current local content as the new baseline, so the user must review and merge those files first.

The updater preserves files that the project changed locally. A `locally_modified` result means only the checkout changed it; `conflict` means both the checkout and Harness changed it. When either appears, identify the path and leave resolution to the user unless they explicitly ask to merge it.
