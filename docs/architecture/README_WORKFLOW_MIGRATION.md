# README Workflow

`README.md` defines the supported public stage sequence:

1. `requirements-definition`
2. `ubiquitous-language-definition`
3. `use-case-definition`
4. `event-storming`
5. `ddd-architecture-definition`
6. `technical-decisions`
7. `plan-writing`
8. `implementation`

The public launcher exposes these stages and supporting inspection commands.
Parallel wrapper entrypoints are removed from the public surface.

The implementation workflow is an internal executor for the final README stage.
It preserves plan security review, independent plan review, execution,
verification, remediation, plan completion, and scope-safe ChangeSet delivery.
Delivery is not a separate public workflow command or skill entrypoint.
