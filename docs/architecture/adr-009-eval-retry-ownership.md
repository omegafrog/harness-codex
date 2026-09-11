# ADR-009: Eval Retry 소유권

- 상태: Accepted
- 결정일: 2026-09-10

## Context

Eval Runner가 내부적으로 재시도하면 first-attempt behavior가 사라지고, policy failure와 infrastructure flake가 섞이며 token·latency 측정이 왜곡된다.

## Decision

```yaml
retry:
  runner:
    automatic: false
  owner:
    - suite
    - ci
  max_attempts: 1
  retry_on:
    - inconclusive
  retry_on_failed: false
  new_run_id_per_attempt: true
```

`max_attempts: 1`은 retry 없음이다. Suite/CI가 필요하다고 명시한 경우에만 `max_attempts: 2`처럼 한 번의 재실행을 허용할 수 있다. 재실행은 새 `run_id`를 만들고 이전 attempt를 연결한다.

```json
{
  "run_id": "run-002",
  "retry_of": "run-001",
  "attempt": 2
}
```

각 attempt의 result, report, trajectory, events, recording을 별도로 보존한다. Runner는 관찰자이며 복구 orchestration을 하지 않는다.

각 report는 `attempt.number`, `attempt.kind`, `attempt.retry_of`, first-attempt/retry-attempt Efficiency·상태 통계와 inconclusive reason 분포를 기록한다. 여러 attempt report의 비교·집계는 `aggregateSuiteAttempts`가 담당하며 runner가 자동 재시도하지 않는다.

## Consequences

- 첫 실행 결과와 재실행 결과를 분리해 분석할 수 있다.
- CI/suite가 retry policy와 비용을 명시적으로 관리해야 한다.
- Attempt linkage와 결과 집계 규칙이 필요하다.
