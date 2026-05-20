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
./harness update --ref <branch-or-tag-or-commit> --skip-venv
./harness update --branch <branch-name>
./harness update --repo https://github.com/omegafrog/harness-codex
```

- `--dry-run`: print the installer command without running it.
- `--ref`: branch, tag, or commit to install. Defaults to `main`.
- `--branch`: branch to install. Convenience alias for `--ref` when testing a runtime branch.
- `--repo`: GitHub repository URL. Defaults to `https://github.com/omegafrog/harness-codex`.
- `--skip-venv`: skip venv creation and dependency installation.

`--ref` and `--branch` are mutually exclusive. Use only one of them.

## Testing a Runtime Branch

To run a project with a runtime from a feature branch:

```bash
./harness update --branch codex/some-runtime-branch
```

The update output prints the selected ref before running the installer:

```text
Selected harness-codex ref: codex/some-runtime-branch
```

## Warning

`./harness update` runs the installer with `--force`. It may overwrite:

- `harness_codex/`
- `.harness/`
- `.codex/`
- `tests/runtime/`
- `./harness`

Back up local changes to harness runtime files before updating.
