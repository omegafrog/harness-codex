# Harness Reset Command

Use `harness reset` to explicitly reset local harness runtime artifacts.

Reset is separate from `harness update`. Update must preserve workflow-generated artifacts; reset is the command that intentionally targets them.

## Dry run by default

Reset does not change files unless `--apply` is provided.

```bash
./harness reset --runs
./harness reset --workflow-artifacts
./harness reset --all
```

To apply a reset:

```bash
./harness reset --runs --apply
./harness reset --workflow-artifacts --apply
./harness reset --all --apply
```

## Scopes

### `--runs`

Targets local runtime state only:

- `.harness/runs/`
- `.harness/sessions/`
- `.harness/state/`
- `.harness/checkpoints/`

Use this when you want to clear execution state but keep ChangeSets, work-item documents, plans, and harvested design docs.

### `--workflow-artifacts`

Targets workflow-generated artifacts:

- `.harness/ui/grill-me-runs/`
- `docs/changes/`
- `docs/use-cases/`
- `docs/maintenance/`
- `docs/plans/`
- `context.md`

Use this when you want to restart the workflow artifact set.

### `--all`

Targets both run state and workflow artifacts.
