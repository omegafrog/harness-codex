# Runtime Shell Completion

The `harness` runtime ships Bash and Zsh completion scripts.

Completion reads the current repository filesystem, so IDs such as `change_set_id`, `uc_id`, `work_item_id`, `run_id`, and `stage` can be selected with `Tab`. ChangeSet candidates keep the inserted value as the ID and display the human-readable title with that ID.

## Bash

From repository root:

```bash
source completions/harness.bash
```

To keep it enabled, add this to `~/.bashrc`:

```bash
source /path/to/harness-codex/completions/harness.bash
```

## Zsh

From repository root:

```zsh
mkdir -p ~/.zfunc
cp completions/_harness ~/.zfunc/_harness
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

## Completion Targets

| Command | Completion candidates |
| --- | --- |
| `harness help <TAB>` | Supported runtime command names |
| `harness changes <TAB>` | Supported `changes` subcommands |
| `harness run <TAB>` | `app` |
| `harness run app <TAB>` | `status`, `stop`, `attach`, `--foreground`, `--timeout` |
| `harness run app attach <TAB>` | `infra`, `server` |
| `harness changes show <TAB>` | ChangeSet IDs from `docs/changes/active/*.md` and `docs/changes/completed/*.md` |
| `harness changes contents <TAB>` | ChangeSet IDs from `docs/changes/active/*.md` and `docs/changes/completed/*.md` |
| `harness changes delete <TAB>` | Active ChangeSet IDs |
| `harness changes continue <TAB>` | Active ChangeSet IDs |
| `harness changes document-delta <TAB>` | Active ChangeSet IDs |
| `harness contracts validate <TAB>` | ChangeSet IDs from active and completed ChangeSets |
| `harness requirements-definition <TAB>` | Active ChangeSet IDs |
| `harness ubiquitous-language-definition <TAB>` | Active ChangeSet IDs |
| `harness use-case-definition <TAB>` | Active ChangeSet IDs |
| `harness event-storming <TAB>` | Active ChangeSet IDs |
| `harness ddd-architecture-definition <TAB>` | Active ChangeSet IDs |
| `harness technical-decisions <TAB>` | Active ChangeSet IDs |
| `harness plan-writing <TAB>` | Active ChangeSet IDs |
| `harness implementation <TAB>` | Active ChangeSet IDs |
| `harness stages list <TAB>` | ChangeSet IDs from active and completed ChangeSets |
| `harness artifacts show <CHG-ID> <TAB>` | Runtime stage IDs |
| `harness artifacts accept <CHG-ID> <TAB>` | Runtime stage IDs |
| `harness resume <TAB>` | Run IDs from `.harness/runs/*` |
| `harness report <TAB>` | Run IDs from `.harness/runs/*` |
| `harness update --<TAB>` | Supported runtime update options |
| `harness reset --<TAB>` | Supported reset scope/options |

## Lookup Root

Completion reads from `HARNESS_REPO_ROOT` when it is set. Otherwise it reads from the current working directory. Set `HARNESS_REPO_ROOT=/path/to/project` when running a harness command from a different directory than the target project.

## Candidate Rules

- ChangeSet ID: file stem from `docs/changes/active/*.md` and `docs/changes/completed/*.md`; displayed with the parsed ChangeSet title when the shell supports descriptions.
- UC ID: directory name from `docs/use-cases/*` or affected use-case rows in the selected ChangeSet document
- Maintenance ID: affected maintenance/work-item rows in the selected ChangeSet document
- Work item ID: ordered work item IDs from the selected ChangeSet document
- Run ID: directory name from `.harness/runs/*`
- Stage ID: built-in runtime stage names and file stems from `.harness/stages/<CHG-ID>/*.md`

## Examples

```bash
harness requirements-definition CHG-20260507-001
harness event-storming CHG-20260507-001 --uc UC-001
harness implementation CHG-20260507-001 --apply
harness artifacts show CHG-20260507-001 technical-decisions
```
