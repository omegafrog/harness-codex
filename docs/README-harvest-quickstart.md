# Harvest Quickstart and CLI Options

This document explains the `harvest` command options and the relationship between design documents and ChangeSet runtime inputs.

## Recommended startup flow

When a repository does not yet have current design documents, run harvest before creating a ChangeSet.

```bash
./harness agent-context init --description "<repo description>"
./harness harvest --idea "<feature idea>" --plan
./harness harvest --idea "<feature idea>" --interactive
./harness changes create-from-design --title "<change title>" --change-set-id CHG-YYYYMMDD-001
./harness run-change CHG-YYYYMMDD-001 --plan
./harness run-change CHG-YYYYMMDD-001 --apply
```

If `docs/design/요구사항.md` and `docs/design/유스케이스.md` already exist and are current, start from `changes create-from-design`.

## What each command does

### `harvest`

`harvest` creates or updates canonical design documents:

- `docs/design/요구사항.md`
- `docs/design/유스케이스.md`

### `changes create-from-design`

`changes create-from-design` does not create design documents. It reads existing design documents and creates runtime inputs:

- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/...`

## Harvest modes

```bash
./harness harvest --idea "<feature idea>" --plan
./harness harvest --idea "<feature idea>" --preview
./harness harvest --idea "<feature idea>" --apply
./harness harvest --idea "<feature idea>" --interactive
```

- `--idea`: initial product or feature idea to turn into requirements and use-case design documents.
- `--plan`: show the harvest workflow plan without changing files.
- `--preview`: show a no-side-effect preview. It currently has the same behavior as `--plan`.
- `--apply`: run the non-interactive harvest workflow through the agent runner.
- `--interactive`: run the Grill-Me question/answer loop in the terminal and generate design documents after the requirements gate passes.

## Help expectation

`./harness harvest --help` should be enough to understand these options without opening the source code.
