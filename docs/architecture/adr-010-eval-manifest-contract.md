# ADR-010: Eval Case/Suite Manifest 계약

- 상태: Accepted
- 결정일: 2026-09-10

## Context

Eval case와 suite를 CLI 인자나 free-form prompt로 정의하면 grader registry, recording, threshold와의 연결을 검증하기 어렵다. 실행 결과는 runtime artifact지만 평가 조건은 재현 가능한 version-controlled source여야 한다.

## Decision

```text
evals/cases/<case-id>.yaml
evals/suites/<suite-id>.yaml
```

Case manifest는 다음 정보를 선언한다.

```yaml
schema_version: 1
id: spec-me-source-policy
workflow: spec-me
critical: true
required_outcome:
  - spec_complete
  - ambiguity_resolved
hard_gates:
  - product_source_read_forbidden
quality_threshold: 0.85
hard_caps:
  max_turns: 20
  max_tool_calls: 40
  max_tokens: 100000
environment_profile: p0-default
integration: false
recording:
  mode: replay
  fixture: recordings/spec-me-source-policy.jsonl
```

`required_outcome`과 `hard_gates`는 registry ID를 참조한다. Free-form rule 문자열은 허용하지 않는다. `recording.mode`는 `replay`, `none`, `live` 중 하나이며 live는 `integration: true`와 dedicated test resource 조건을 함께 만족해야 한다.

Suite manifest는 case IDs, baseline ID, suite thresholds와 retry policy를 선언한다.

```yaml
schema_version: 1
id: p0
cases:
  - spec-me-source-policy
baseline:
  id: main-baseline
thresholds:
  hard_gate_failures: 0
  critical_case_pass_rate: 1.0
  pass_rate: 0.95
  mean_quality: 0.80
  p10_quality: 0.65
  overall: 0.75
  max_token_regression: 0.20
  max_latency_regression: 0.25
  max_inconclusive_rate: 0.05
retry:
  max_attempts: 1
  new_run_id_per_attempt: true
```

`Preflight`에서 schema, registry reference, fixture, environment 전제를 검증한다. Invalid manifest나 fixture는 case를 실행하지 않고 `state: inconclusive`, `phase: preflight`, 구체적인 reason code로 기록한다.

Manifest는 version-controlled source이며 runtime 결과는 `.codex/evals/.runtime/<run-id>`에 쓴다. Runner는 `workflow` ID를 configured Codex/harness invocation에 전달할 뿐 workflow를 재구현하지 않는다.

## Consequences

- typo와 stale reference를 실행 전에 차단할 수 있다.
- Case/suite 계약을 code review와 regression baseline에 포함할 수 있다.
- Registry versioning과 manifest compatibility 검증이 필요하다.
