# Harness Operations Guide

## Workflow

`README.md` defines the supported public stage sequence:

```bash
./harness requirements-definition --title "<title>" --idea "<idea>"
./harness ubiquitous-language-definition <CHG-ID>
./harness use-case-definition <CHG-ID>
./harness event-storming <CHG-ID> --uc <UC-ID>
./harness ddd-architecture-definition <CHG-ID> --uc <UC-ID>
./harness technical-decisions <CHG-ID> --uc <UC-ID>
./harness plan-writing <CHG-ID> --uc <UC-ID> --apply
./harness implementation <CHG-ID> --apply
```

`plan-writing` and `implementation` support `--plan`, `--preview`, and
`--apply`. Implementation owns its internal plan-security review, execution,
verification, remediation, plan completion, and approved ChangeSet delivery.
Those are not separate public workflow commands.

## Artifacts

- Active ChangeSet: `docs/changes/active/<CHG-ID>.md`
- Completed ChangeSet: `docs/changes/completed/<CHG-ID>.md`
- Use-case slice: `docs/use-cases/<UC-ID>/`
- Maintenance slice: `docs/maintenance/<MAINT-ID>/`
- Active plan: `docs/plans/active/<WORK-ITEM-ID>/plan.md`
- Completed plan: `docs/plans/completed/<WORK-ITEM-ID>/plan.md`
- Runtime state: `.harness/runs/<RUN-ID>/state.json`
- Run report: `.harness/runs/<RUN-ID>/report.md`
- Delivery report: `.harness/runs/<RUN-ID>/pull-request.json`

## Resume and Inspection

```bash
./harness changes list
./harness changes active
./harness changes show <CHG-ID>
./harness changes continue <CHG-ID> --apply
./harness stages list <CHG-ID>
./harness resume <RUN-ID>
./harness report <RUN-ID>
```

## Operations and Verification

```bash
./harness run app
./harness run wiki build
./harness ui-server
./venv/bin/python3 -m pytest -q -s tests/runtime
./venv/bin/python3 -m pytest -q -s
```

Project-specific checks are configured in `.codex/test-gate.yaml` and
`.codex/repository-settings.md`.
