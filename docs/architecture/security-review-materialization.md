# Security Review Runtime Materialization

## Purpose

The security implementation reviewer runs with a `read-only` sandbox. It must not write implementation code, plans, ChangeSet documents, upstream artifacts, or runtime artifact paths.

The reviewer returns one Markdown report in its final response. The runtime owns persistence of that response under the workflow-declared report path.

## Workflow Contract

1. `review-work-item-security` invokes `security_implementation_reviewer` with no declared file outputs.
2. The provider adapter persists the agent final response as:
   `.harness/runs/<RUN-ID>/steps/review-work-item-security/final-message.md`.
3. `verify-work-item-security` invokes `harness_codex.runtime.materialize_security_review`.
4. The materializer validates `Security Review Status: approved|rejected`, writes:
   `.harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/security/security-review.md`, and returns:
   - `0` for `approved`;
   - `2` for `rejected`, after the report has been written;
   - `1` for a missing, empty, or malformed final response.

Only the materialized report is the security gate artifact. An approved report permits the workflow to continue; rejected or malformed responses stop the validator step.

## Report Shape

The final response must include the required status line and these sections:

- `## Reviewed Inputs`
- `## Security Findings`
- `## Remediation Target`
- `## Evidence`

An approved review declares `none` for the remediation target. A rejected review identifies `plan` or `implementation` as the owner.
