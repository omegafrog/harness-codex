# Harness Update Command

Installed projects can update their embedded harness-codex runtime with:

```bash
./harness update
```

The command downloads the installer from the configured harness-codex repository and reruns it with `--force --target <repo-root>`.

## Options

```bash
./harness update --dry-run
./harness update --ref main
./harness update --ref <branch-or-commit> --skip-venv
./harness update --repo https://github.com/omegafrog/harness-codex
```

- `--dry-run`: print the installer command without running it.
- `--ref`: branch, tag, or commit to install. Defaults to `main`.
- `--repo`: GitHub repository URL. Defaults to `https://github.com/omegafrog/harness-codex`.
- `--skip-venv`: skip venv creation and dependency installation.

## Preservation policy

`./harness update` refreshes runtime-managed files while preserving workflow-generated artifacts and project-local configuration.

Update may replace:

- `harness_codex/`
- bundled `.harness/` runtime/workflow files
- bundled `.codex/` agents and skills
- `tests/runtime/`
- `./harness`

Update must preserve existing workflow outputs and local project state, including:

- `.harness/runs/`
- `.harness/sessions/`
- `.harness/state/`
- `.harness/checkpoints/`
- `.harness/ui/grill-me-runs/`
- `docs/changes/`
- `docs/use-cases/`
- `docs/maintenance/`
- `docs/plans/`
- `docs/design/요구사항.md`
- `docs/design/유스케이스.md`
- `context.md`
- `.codex/repository-settings.md`
- `.codex/stack-profile.yaml`
- `.codex/test-gate.yaml`
- `AGENTS.md`

Destructive state cleanup should be implemented as an explicit reset command or flag, not as part of update.
