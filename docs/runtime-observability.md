# Runtime Observability

Harness records a local-first observability ledger for every normal runtime execution.

## Artifacts

Each run writes the following files below `.harness/runs/<RUN-ID>/`.

```text
.harness/runs/<RUN-ID>/
  events.ndjson
  metrics.json
```

`events.ndjson` is append-only and is the source artifact. `metrics.json` is a deterministic projection rebuilt from that ledger after every completed or raised step and after every workflow result.

## Event boundary

The runtime instruments these lifecycle events without changing the execution result:

- `run.started`
- `workflow.started`
- `workflow.finished`
- `workflow.raised`
- `step.started`
- `step.finished`
- `step.raised`

Every event is correlated by `run_id`, and where available also by `change_set_id`, `work_item_id`, workflow name, step id, step kind, and agent id.

## Metrics

`metrics.json` contains the following aggregate views:

- event count and observed timestamps
- status counts for completed steps
- per-step count, total, average, p50, p95, and maximum duration
- five highest-total-duration bottlenecks

The projection intentionally uses local JSON rather than requiring an external collector. This keeps the first measurement loop available in local development, tests, and CI artifacts. A later exporter can consume the NDJSON ledger for OpenTelemetry or Prometheus-compatible infrastructure.

## Data-safety boundary

The ledger does not persist prompts, model outputs, source code, stdout, stderr, or arbitrary step metadata. It records only an allowlist of operational attributes such as provider, execution mode, retry attempt, termination reason, review-cache state, and gate status.

Observability is best-effort: event or metric write failures are swallowed so disk, serialization, or permission errors cannot change a workflow outcome or hide the original failure.
