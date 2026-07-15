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

Workflow inputs that affect a downstream decision use runtime-owned Python
contract readers and writers. There is no active XSD validation layer.

현재 typed handoff는 `execution-scope`, `execution-report`,
`security-profile`, `security-controls`, `security-bundle-manifest`,
`token-metrics`, `finalization-report`, `gate-verdict`이다. 설치 결과는 handoff가
아니며 기존 installer 결과 모델로 반환한다.

A handoff is rejected when its type, schema version, or required identity and
status fields are missing or invalid.

## 계약 authority 경계

XML 계약은 역할별 Python authority가 소유한다.

- `subagent_contract.py`: orchestration subagent handoff
- `runtime_tool_contract.py`: Runtime tool 호출
- `xml_handoff.py`: workflow artifact handoff
- `xml_state.py`: canonical runtime state

계약 간 parser/writer를 재구현하지 않는다. `gate-verdict`는 `xml_handoff.py`가
검증하며, Runtime tool result와 subagent result가 이를 대신하지 않는다.

`repair-brief`, owner/resume/retry/remediation routing 필드는 계약에 없다.
Verifier 결과에 legacy-shaped routing key가 들어오면 중첩 위치와 무관하게 거부한다.

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
