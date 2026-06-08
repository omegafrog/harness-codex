# Harness Update Command

Installed projects can update their embedded harness-codex runtime from `origin/main` with:

```bash
./harness update
```

The command downloads the installer from the configured harness-codex repository and reruns it with `--force --target <repo-root>`. By default, the user-facing source ref is `origin/main`; for GitHub archive/download URLs this is normalized to the downloadable branch ref `main`.

The runtime has its own semantic version in `harness_codex/__init__.py`. A completed update prints the installed version transition, for example `Runtime version: 0.1.0 -> 0.1.1`. A dry run prints the currently installed runtime version without claiming a target version.

## Version automation

When a pull request is merged into `main`, `.github/workflows/bump-runtime-version.yml` increases the runtime patch version and pushes a follow-up bot commit to `main`. A bot push does not retrigger the workflow because the workflow listens only for merged pull requests.

The workflow requires `contents: write` permission for `GITHUB_TOKEN`. If repository branch rules prevent GitHub Actions from pushing directly to `main`, those rules must allow this workflow or the automated version commit will fail.

## Options

```bash
./harness update --dry-run
./harness update --ref origin/main
./harness update --ref <branch-or-commit> --skip-venv
./harness update --repo https://github.com/omegafrog/harness-codex
```

- `--dry-run`: print the installer command without running it.
- `--ref`: branch, tag, or commit to install. Defaults to `origin/main`. Remote-tracking refs such as `origin/main` and `refs/remotes/origin/main` are normalized to GitHub-downloadable refs such as `main`.
- `--repo`: GitHub repository URL. Defaults to `https://github.com/omegafrog/harness-codex`.
- `--skip-venv`: skip venv creation and dependency installation.

## Preservation policy

`./harness update` refreshes runtime-managed files while preserving workflow-generated artifacts and project-local configuration. After a successful update, it also installs the bundled shell completion for the detected shell so user-level completion stays aligned with the refreshed runtime.

Update may replace:

- `harness_codex/`
- bundled `.harness/` runtime/workflow files
- bundled `.codex/` agents and skills
- `completions/`
- `tests/runtime/`
- `./harness`
- user-level shell completion such as `~/.zfunc/_harness` or `~/.local/share/bash-completion/completions/harness`

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
