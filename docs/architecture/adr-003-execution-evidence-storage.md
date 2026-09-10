# ADR-003: 실행 Evidence 저장 경계

- 상태: Accepted
- 결정일: 2026-09-10

## Context

Resume에 필요한 현재 상태와 실행 분석에 필요한 history는 서로 다른 수명과 의미를 가진다. Behavioral Eval은 Codex raw trajectory, runner가 정규화한 lifecycle/policy event, 외부 호출 recording, 판정 결과를 함께 보존해야 한다. 기존 `.harness` 경로는 사용하지 않는다.

## Decision

Plan execution과 Behavioral Eval artifact를 분리한다.

```text
Plan execution:
docs/plans/.runtime/{plan-id}/
├── checkpoint.md
└── events.jsonl

Behavioral Eval:
.codex/evals/.runtime/{run-id}/
├── result.json
├── cases/{case-id}/
│   ├── trajectory.jsonl
│   ├── events.jsonl
│   └── recording.jsonl
└── report.json
```

- `checkpoint.md`: resume projection
- Plan `events.jsonl`: plan 실행 history/evidence
- `trajectory.jsonl`: Codex가 실제로 수행한 interaction/tool trajectory
- Eval `events.jsonl`: Eval Runner가 관찰·정규화·분류한 lifecycle/policy event
- `recording.jsonl`: stub 외부 호출의 normalized request/response
- `result.json`: case/suite structured 판정 결과
- `report.json`: 사람이 보거나 CI가 집계하는 derived report

모든 runtime artifact는 gitignored다. GitHub tracker status는 별도 canonical source로 유지한다. Case 간 workspace, artifact, recording은 공유하지 않는다.

## Event Stream 계약

각 stream은 단일 writer가 소유하며 다음 envelope를 사용한다.

```yaml
event_stream:
  writer: single
  ordering:
    sequence: monotonic
  format:
    one_event_per_line: true
    encoding: utf-8
  persistence:
    append_only: true
    critical_events:
      flush: true
      fsync: true
```

```json
{
  "schema_version": 1,
  "stream_id": "plan-491",
  "seq": 42,
  "timestamp": "...",
  "type": "test_passed",
  "payload": {}
}
```

Replay validation은 valid JSON, schema, `stream_id` 일치, `seq == previous_seq + 1`을 확인한다. 마지막 malformed line은 원본을 삭제하지 않고 quarantine한다. Sequence gap 또는 duplicate sequence는 corruption으로 판정하며 마지막 valid contiguous event까지만 replay하고 recovery evidence를 남긴다.

`checkpoint.md`의 source는 replay된 valid events다. 갱신은 temp file에 완전히 쓴 뒤 atomic replace하며, checkpoint는 authoritative history가 아니다. Event history를 checkpoint에서 역으로 복원하지 않는다.

## Trajectory 계약

`trajectory.jsonl`은 Codex, harness, external actor가 실제로 수행한 행동을 기록한다.

```yaml
trajectory_record:
  schema_version: 1
  stream_id: ...
  seq: ...
  timestamp: ...
  actor: codex | harness | external
  kind: message | tool_call | tool_result | process_event
  correlation_id: optional
  action: ...
  target: ...
  status: optional
  payload: normalized
  source: structured_event | stdout_fallback
```

`tool_call`과 `tool_result`는 `correlation_id`로 연결한다. `status`는 결과성 record에서만 선택적으로 사용하며 `success`, `error`, `denied`, `cancelled`를 허용한다. Structured event를 우선하고 stdout parsing은 fallback으로만 사용한다. Raw workspace와 raw provider payload는 grader 입력이나 기본 trajectory에 포함하지 않으며, 필요한 debug raw data는 별도 opt-in artifact로만 저장한다. Secret과 credential은 저장 전에 제거한다.

`actor: harness`는 process launch나 checkpoint helper 호출처럼 실제 harness component가 수행한 행동만 의미하며 workflow semantics를 Runner가 수행했다는 뜻이 아니다.

## Consequences

- Grader는 raw trajectory와 normalized event를 목적에 맞게 선택할 수 있다.
- checkpoint 변경과 evidence history를 혼동하지 않는다.
- runtime artifact 정리·보존 정책이 두 실행 종류별로 필요하다.
- eval artifact 경로는 `.codex/evals/.runtime`으로 고정하며 `.harness/skill-evaluations`를 부활시키지 않는다.
