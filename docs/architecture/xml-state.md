# XML State Authority

## Canonical document

Every ChangeSet has exactly one durable state document:

```text
.harness/state/changesets/<CHG-ID>/state.xml
```

The document contains ChangeSet-owned UI interaction state, canonical stage
artifacts, run state, work-item state, verifier summary, resumable job state,
and the step transaction ledger. Runtime state changes use atomic replacement
after XML contract validation.

A saved UI session is projected into the canonical RunState in the same XML
document. UI completion and stage gates therefore do not depend on different
state files.

## Reader and writer contract

- `RunStateStore`, dashboard projection, stage gates, resume logic, and UI
  session restore read the canonical XML document.
- Runtime-owned XML stores are the only durable state writers.
- Agents return final messages; runtime validators materialize XML handoffs.
- The ChangeSet Markdown procedure table provides document structure only. It
  cannot provide a status used for gates, dashboard state, or resume.
- Legacy JSON state, scoped UI sessions, stage-rerun snapshots, and SQLite step
  ledgers are not read as state fallbacks.

## XML handoff contract

Workflow inputs that affect a downstream decision use the fixed handoff
namespace `urn:harness:handoff:v1` and `schemas/harness-handoff-v1.xsd`.

Current typed handoffs: `execution-scope`, `execution-report`,
`verification-report`, `repair-brief`, `security-profile`,
`security-controls`, `security-bundle-manifest`, and `finalization-report`.

A handoff is rejected when its type, schema version, or required identity and
status fields are missing or invalid.

## Evidence boundary

Raw reports, stdout/stderr, diffs, provider telemetry, Markdown review output,
and JSON emitted by a third-party tool are evidence, not state. A verifier may
read evidence, then writes an XML verdict. Gates, dashboard state, resume, and
subsequent workflow contracts consume that XML verdict rather than raw files.

## Migration rule

There is no automatic fallback from XML to a legacy JSON or Markdown state file.
A ChangeSet without XML state is blocked and must be migrated explicitly before
resume. Cleanup removes XML state and disposable evidence by ChangeSet path;
it never infers ownership by parsing JSON.
