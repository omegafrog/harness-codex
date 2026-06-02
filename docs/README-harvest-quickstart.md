# Harvest Quickstart and CLI Options

This document explains the `harvest` command options and the relationship between design documents and ChangeSet runtime inputs.

## Recommended startup flow

When a repository does not yet have current design documents, run harvest before creating a ChangeSet.

```bash
./harness init --description "<repo description>"
./harness harvest --idea "<feature idea>" --plan
./harness harvest --idea "<feature idea>" --interactive --session-id harvest-001
./harness harvest sessions
./harness harvest --interactive --session-id harvest-001 --resume
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

Interactive harvest assigns a session id and stores a resumable session snapshot under:

- `.harness/ui/sessions/<SESSION-ID>.json`
- `.harness/ui/harvest-session.json` for legacy compatibility with the UI runtime

List saved interactive sessions with:

```bash
./harness harvest sessions
```

The session list shows:

- session id
- active stage
- requirements gate status
- use-case readiness
- initial idea

If an interactive run is interrupted, resume it with the same session id:

```bash
./harness harvest --interactive --session-id <SESSION-ID> --resume
```

A completed session cannot be resumed as a question loop. The command reports that the session is already complete and prints the next `changes create-from-design` step.

### `changes create-from-design`

`changes create-from-design` does not create design documents. It reads existing design documents and creates runtime inputs:

- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/...`

## Harvest modes

```bash
./harness harvest --idea "<feature idea>" --plan
./harness harvest --idea "<feature idea>" --interactive --session-id harvest-001
./harness harvest sessions
./harness harvest --interactive --session-id harvest-001 --resume
```

- `--idea`: initial product or feature idea to turn into requirements and use-case design documents.
- `--session-id`: interactive harvest session id. If omitted, the runtime generates one.
- `--resume`: resume an existing interactive harvest session instead of starting a new one.
- `sessions`: list saved interactive harvest sessions from `.harness/ui/sessions`.
- `--plan`: show the harvest workflow plan without changing files. Treat this as debug/explain mode.
- `--interactive`: run the Grill-Me question/answer loop in the terminal and generate design documents after the requirements gate passes.

## Help expectation

`./harness harvest --help` should be enough to understand these options without opening the source code.
