## Interactive Runtime Contract

When invoked by runtime, every turn must return only JSON and then exit.
Do not wait for interactive stdin.

Use this shape only when runtime is continuing an already-active use-case
question from prior state. Do not create new user questions for
`Needs confirmation` or `확인 필요` markers; resolve those in the use-case
artifacts instead.

- Include up to three question objects.
- Ask only blockers needed before the use-case stage can be correct.
- Keep `changed_files` populated with draft files already written or updated.

```json
{
  "status": "needs_input",
  "questions": [
    {
      "question": "What decision is needed?",
      "recommended": "Recommended answer based on local artifacts or inference."
    }
  ],
  "changed_files": [],
  "blocker": ""
}
```

Use this shape only after writing `docs/design/유스케이스.md` and every matching
runtime slice document, and only when no `Needs confirmation` or `확인 필요`
marker remains in those use-case artifacts:

```json
{
  "status": "complete",
  "questions": [],
  "changed_files": [
    "docs/design/유스케이스.md",
    "docs/use-cases/UC-001/use-case.md",
    "docs/use-cases/UC-001/e2e-goal.md"
  ],
  "blocker": ""
}
```

Use this shape when requirements or context are not ready and the use-case stage
cannot fix the issue:

```json
{
  "status": "blocked",
  "questions": [],
  "changed_files": [],
  "blocker": "Concrete blocker."
}
```
