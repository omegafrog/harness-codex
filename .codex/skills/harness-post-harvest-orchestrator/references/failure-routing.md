## Failure Routing

Classify every UC verification failure before choosing the next stage:

- `IMPLEMENTATION_FAILURE`: code, tests, configuration, or static analysis fails inside the approved UC plan and ChangeSet scope. Return only this type to the UC plan remediation loop.
- `UNCLEAR_E2E_GOAL`: the UC E2E goal is missing, ambiguous, untestable, or not user-approved. Return to the harvester/user goal gate.
- `DOCUMENT_DELTA_CONFLICT`: the ChangeSet, UC docs, E2E goal, or plan disagree about scope or intended behavior. Return to ChangeSet revision.
- `UPSTREAM_DESIGN_CONFLICT`: event storming, DDD design, technical decisions, architecture, or repository structure must change before implementation can proceed. Return to the relevant event storming, DDD, technical-decision, or architecture stage.
- `ENVIRONMENT_BLOCKER`: permissions, network, Playwright browser installation, credentials, unavailable external services, or host tooling prevent verification. Record the blocker and stop.

Only `IMPLEMENTATION_FAILURE` may add remediation tasks to `docs/plans/active/<UC-ID>/plan.md` and
repeat `$harness-plan-executor`. All other failure types must leave the executor loop and report the
stage that owns the correction.

