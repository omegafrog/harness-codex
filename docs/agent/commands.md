# Agent Commands

## Python Runtime

- Full Python test gate: `./venv/bin/python3 -m pytest -q -s`
- Create a ChangeSet and run all affected workflows: `python3 -m harness_codex ultrawork --title "<title>"`
- List active ChangeSets: `python3 -m harness_codex changes list`
- Show ChangeSet: `python3 -m harness_codex changes show <CHG-ID>`
- Delete active ChangeSet: `python3 -m harness_codex changes delete <CHG-ID>`
- Preview use-case workflow: `python3 -m harness_codex run-use-case <CHG-ID> <UC-ID> --preview`
- Preview work item workflow: `python3 -m harness_codex run-work-item <CHG-ID> <WORK-ITEM-ID> --preview`
- Show run report: `python3 -m harness_codex report <RUN-ID>`
- Initialize target repo agent context: `python3 -m harness_codex init --description "<repo description>"`

Use `python3` for Python commands. Use the repository-root `venv` for dependencies and test execution.

## Dashboard

- Check dashboard JavaScript syntax: `node --check harness_codex/runtime/dashboard_assets/dashboard.js`
- Check runtime dashboard Python modules: `python3 -m py_compile harness_codex/runtime/ui_server.py harness_codex/runtime/document_dashboard.py`
- Run dashboard server: `python3 -m harness_codex ui-server`

## Agent Context Measurement

- Agent files word count: `find . -name AGENTS.md -print | sort | xargs -r wc -w`
- Docs markdown word count: `find docs -type f -name '*.md' -print0 2>/dev/null | xargs -0 wc -w | tail -1`
- Agent docs word count: `wc -w docs/agent/*.md`

## Verification For Context Compaction

Run after agent-context edits:

```bash
find . -name AGENTS.md -print | sort | xargs -r wc -w
wc -w docs/agent/*.md
rg -n -P "\p{Hangul}" AGENTS.md docs/agent || true
git diff --stat
git status --porcelain=v1 -uno
```

Full test suite is optional for docs-only context changes. Use `./venv/bin/python3 -m pytest -q -s` when behavior or workflow logic changes.

## Diagnostic Order

1. Use concise status commands first.
2. Use diff stats before targeted diffs.
3. Run narrow tests before full test gates when scope is small.
4. Summarize logs and failures instead of pasting full output.
5. Cap routine command output near 4k tokens.
