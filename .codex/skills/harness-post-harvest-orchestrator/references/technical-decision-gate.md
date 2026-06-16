## Technical Decision Gate

After `$harness-ddd-design`, run `$harness-technical-decisions` for the affected UC before planning.

This gate owns detailed technical choices that should not be forced during requirements elicitation:

- polling vs push/webhook/scheduler
- circuit breaker, retry/backoff, timeout, bulkhead
- outbox/inbox, idempotency, message ordering, duplicate handling
- transaction propagation, eventual consistency, compensation
- cache TTL, invalidation, Redis usage details
- messaging topic/queue/channel and consumer failure policy
- logging, metrics, tracing, audit fields
- integration/contract/container test strategy

If `docs/use-cases/<UC-ID>/technical-decisions.md` or `docs/design/기술결정.md` has unresolved items
that affect implementation scope, stop and ask the user. Do not send unresolved implementation
choices to the planner.

