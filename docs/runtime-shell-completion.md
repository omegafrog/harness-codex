# Runtime Shell Completion

`harness` provides Bash and Zsh completion scripts for current staged workflow commands.

Completion reads the local repository filesystem, so users can discover ChangeSet IDs, UC IDs, run IDs, and stage IDs with `Tab`.

## Bash

Run from the repository root:

```bash
source completions/harness.bash
```

To keep completion enabled, add the same command to `~/.bashrc`.

## Zsh

Install completion from the repository root:

```zsh
mkdir -p ~/.zfunc
cp completions/_harness ~/.zfunc/_harness
```

Then ensure `~/.zshrc` loads the completion directory:

```zsh
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

## Completion Targets

| Command | Candidate source |
| --- | --- |
| `harness requirements-definition <TAB>` | Active ChangeSet IDs |
| `harness ubiquitous-language-definition <TAB>` | Active ChangeSet IDs |
| `harness use-case-definition <TAB>` | Active ChangeSet IDs |
| `harness event-storming <TAB>` | Active ChangeSet IDs |
| `harness ddd-architecture-definition <TAB>` | Active ChangeSet IDs |
| `harness technical-decisions <TAB>` | Active ChangeSet IDs |
| `harness plan-writing <TAB>` | Active ChangeSet IDs |
| `harness implementation <TAB>` | Active ChangeSet IDs |

## Examples

```bash
harness requirements-definition CHG-20260507-001 --preview
harness event-storming CHG-20260507-001 --uc UC-001 --preview
harness implementation CHG-20260507-001 --uc UC-001 --apply
```
