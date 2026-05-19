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

## Warning

`./harness update` runs the installer with `--force`. It may overwrite:

- `harness_codex/`
- `.harness/`
- `.codex/`
- `tests/runtime/`
- `./harness`

Back up local changes to harness runtime files before updating.
