# Agent Commands

See `docs/architecture/canonical-runtime.md` for the authoritative workflow.

## Canonical Runtime

- Harvest design: `python3 -m harness_codex harvest --idea "<request>" --apply --session-id harvest-001`
- Resume harvest: `python3 -m harness_codex harvest --apply --session-id harvest-001 --resume`
- Create scope: `python3 -m harness_codex changes create-from-design --title "<title>"`
- Inspect readiness: `python3 -m harness_codex changes active`
- Execute ChangeSet: `python3 -m harness_codex run-change CHG-YYYYMMDD-001 --apply`
- Execute work item: `python3 -m harness_codex run-work-item CHG-YYYYMMDD-001 MAINT-001 --apply`
- Execute use case: `python3 -m harness_codex run-use-case CHG-YYYYMMDD-001 UC-001 --apply`
- Resume runtime: `python3 -m harness_codex resume run-<id>`
- Read run report: `python3 -m harness_codex report run-<id>`

`RunState` at `.harness/runs/<RUN-ID>/state.json` is authoritative. Do not
store a parallel workflow state in a skill, dashboard, or hand-maintained
session file.

Procedure-stage commands and `ultrawork` are legacy. Follow
`docs/architecture/legacy-command-migration.md`; compatibility documentation
ends on 2026-09-30.

## Verification

```bash
./venv/bin/python3 -m pytest -q -s tests/runtime
./venv/bin/python3 -m pytest -q -s
git diff --check
git status --porcelain=v1 -uno
```
