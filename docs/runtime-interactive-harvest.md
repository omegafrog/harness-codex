# Interactive Harvest Runtime

`harvest` is the canonical design-document creation stage. It produces or updates:

- `docs/design/요구사항.md`
- `docs/design/유스케이스.md`

`changes create-from-design` does not create design documents. It reads existing design documents and creates runtime inputs:

- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/...`

## Recommended flow

```bash
./harness agent-context init --description "<repo description>"
./harness harvest --idea "<feature idea>" --interactive
./harness changes create-from-design --title "<change title>" --change-set-id CHG-YYYYMMDD-001
./harness run-change CHG-YYYYMMDD-001 --plan
./harness run-change CHG-YYYYMMDD-001 --apply
```

If `docs/design/요구사항.md` and `docs/design/유스케이스.md` already exist and are current, start from `changes create-from-design`.

## Harvest modes

```bash
./harness harvest --idea "<feature idea>" --plan
./harness harvest --idea "<feature idea>" --interactive
```

- `--plan`: show the harvest workflow plan without changing files. Treat this as debug/explain mode.
- `--interactive`: run the Grill-Me question/answer loop in the terminal and generate design documents after the requirements gate passes.

Compatibility aliases:

- `--preview`: deprecated alias for `--plan`.
- `--apply`: deprecated alias for `--interactive`.

## Interactive behavior

`harvest --interactive` reuses the existing runtime-backed harvest UI session service.

1. Start a requirements session from `--idea`.
2. Print current Grill-Me questions and recommended answers.
3. Read the user's terminal answer.
4. Save the answer into `.harness/ui/harvest-session.json`.
5. Ask Grill-Me for the next questions.
6. Repeat until the requirements gate passes.
7. Generate `docs/design/요구사항.md` and `docs/design/유스케이스.md`.
8. Print the next command: `./harness changes create-from-design --title "<change title>"`.

The CLI does not keep a long-running agent process open. Each question turn delegates to the existing harvest UI service, which already owns the session state and requirements gate.
