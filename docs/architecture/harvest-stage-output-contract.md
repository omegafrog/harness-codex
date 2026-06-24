# Harvest Stage Output Contract

## Purpose

Harvest stages have separate ownership boundaries. For every agent step, the
workflow `outputs` field is the single source of write authorization. Runtime
scope validation rejects writes outside those paths.

## Stage Contracts

| Stage | Owner | Declared outputs |
| --- | --- | --- |
| Bootstrap / init | `harness init` or `harness agent-context init` | `AGENTS.md` and `docs/agent/*` bootstrap context artifacts |
| Requirements | `requirements_interviewer` | `docs/design/요구사항.md` |
| Ubiquitous language | `ubiquitous_language_reviewer` | `context.md` |
| Use cases | `harness_usecases` | `docs/design/유스케이스.md`, `docs/use-cases/**` |

Bootstrap is not a harvest-agent responsibility. A harvest agent cannot gain
additional permission through metadata such as `bootstrap_outputs`.

## Bootstrap and Migration Compatibility

Existing repositories do not need to delete, move, or regenerate already
committed `AGENTS.md` or `docs/agent/*` files before running harvest. They remain
available as read-only discovery context where a stage chooses to inspect them.

For a new repository, or when bootstrap context should be regenerated, run one
of the explicit commands before harvest:

```bash
python3 -m harness_codex init --description "<repository description>"
# or
python3 -m harness_codex agent-context init --description "<repository description>"
```

Custom workflow authors must remove `metadata.bootstrap_outputs` from agent
steps. Runtime intentionally ignores that legacy key for write authorization, so
it is safe to migrate workflows incrementally: explicit agent `outputs` must
contain every artifact that the agent is permitted to write.

## Boundary Examples

- Requirements may not write `context.md` or `docs/use-cases/**`.
- Ubiquitous-language review may not rewrite `docs/design/요구사항.md` or create
  use-case slices.
- Use-case harvest may not rewrite `context.md` or requirements.
- Use-case harvest may write both its canonical index and its slice directory,
  because both are declared outputs of the same step.
