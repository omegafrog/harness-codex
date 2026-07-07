# XML State Authority

## Canonical document

Every ChangeSet has exactly one durable state document:

```text
.harness/state/changesets/<CHG-ID>/state.xml
```

The document contains the ChangeSet-owned UI interaction state, canonical stage
artifacts, run state, work-item state, verifier summary, resumable job state,
and step transaction ledger. Runtime state changes use atomic replacement after
XML contract validation.

## Reader and writer contract

- `RunStateStore`, dashboard projection, stage gates, resume logic, and UI
  session restore read the canonical XML document.
- Runtime-owned XML stores are the only durable state writers.
- Agents do not write state XML. They return final messages; runtime validators
  materialize bounded XML handoffs from those messages and existing evidence.
- The ChangeSet Markdown procedure table provides document structure only. It
  must not provide a status used for gates, dashboard state, or resume.
- Legacy JSON state, scoped UI sessions, stage-rerun snapshots, and SQLite step
  ledgers are not read as state fallbacks.

## XML handoff contract

Workflow inputs that affect a downstream decision use the fixed handoff
namespace `urn:harness:handoff:v1` and `schemas/harness-handoff-v1.xsd`.

The current typed handoffs are:

- `execution-scope`
- `execution-report`
- `verification-report`
- `repair-brief`
- `security-profile`
- `security-controls`
- `security-bundle-manifest`

A handoff is rejected when its type, schema version, or required identity and
status fields are missing or invalid.

## Evidence boundary

Raw reports, stdout/stderr, diffs, provider telemetry, Markdown review output,
and JSON produced by a third-party tool are evidence, not state. A verifier may
read evidence, then writes an XML verdict. Gates, dashboard state, resume, and
subsequent workflow contracts consume that XML verdict rather than the raw
artifact.

This boundary intentionally allows tools that natively emit JSON to keep their
raw output without restoring a second status authority.

## Migration rule

There is no automatic fallback from XML to a legacy JSON or Markdown state file.
A ChangeSet without the required XML state is blocked and must be migrated
explicitly before resume. Deleting a ChangeSet removes its XML document and its
disposable evidence snapshot by ChangeSet path; cleanup never infers ownership
by parsing JSON.
