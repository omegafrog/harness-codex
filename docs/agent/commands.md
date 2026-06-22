# Agent Commands

`README.md` is the workflow contract. Use its staged commands; do not use a
parallel one-shot orchestration command.

## README Workflow

```bash
python3 -m harness_codex requirements-definition --title "<title>" --idea "<idea>"
python3 -m harness_codex ubiquitous-language-definition <CHG-ID>
python3 -m harness_codex use-case-definition <CHG-ID>
python3 -m harness_codex event-storming <CHG-ID> --uc <UC-ID>
python3 -m harness_codex ddd-architecture-definition <CHG-ID> --uc <UC-ID>
python3 -m harness_codex technical-decisions <CHG-ID> --uc <UC-ID>
python3 -m harness_codex plan-writing <CHG-ID> --uc <UC-ID> --apply
python3 -m harness_codex implementation <CHG-ID> --apply
```

Planning and implementation retain explicit modes:

```bash
python3 -m harness_codex plan-writing <CHG-ID> --uc <UC-ID> --plan
python3 -m harness_codex implementation <CHG-ID> --preview
```

`implementation` owns its internal security review, verification, remediation,
plan completion, and explicitly approved delivery. Do not invoke a separate
workflow wrapper for those tasks.

## Supporting Commands

- Full Python test gate: `./venv/bin/python3 -m pytest -q -s`
- List active ChangeSets: `python3 -m harness_codex changes list`
- Show ChangeSet: `python3 -m harness_codex changes show <CHG-ID>`
- Continue the next incomplete stage: `python3 -m harness_codex changes continue <CHG-ID> --apply`
- Show a run report: `python3 -m harness_codex report <RUN-ID>`
- Initialize target repo context: `python3 -m harness_codex init --description "<repo description>"`

## Dashboard

- Check dashboard JavaScript syntax: `node --check harness_codex/runtime/dashboard_assets/dashboard.js`
- Check runtime dashboard modules: `python3 -m py_compile harness_codex/runtime/ui_server.py harness_codex/runtime/document_dashboard.py`
- Run dashboard server: `python3 -m harness_codex ui-server`

## Diagnostic Order

1. Use concise status commands first.
2. Use diff stats before targeted diffs.
3. Run narrow tests before full test gates when scope is small.
4. Summarize logs and failures instead of pasting full output.
5. Cap routine command output near 4k tokens.
