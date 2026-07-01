## Scope Model

- ChangeSet: `docs/changes/active/<CHG-ID>.md`
- Work item:
  - use case: `docs/use-cases/<UC-ID>/`
  - maintenance: `docs/maintenance/<MAINT-ID>/`
- Active plan: `docs/plans/active/<WORK-ITEM-ID>/plan.md`
- Completed plan: `docs/plans/completed/<WORK-ITEM-ID>/plan.md`

`<WORK-ITEM-ID>` is the concrete use-case ID or maintenance ID selected by the parent workflow.

## Required Inputs

### Always required

- `docs/changes/active/<CHG-ID>.md`
- One selected work-item slice:
  - `docs/use-cases/<UC-ID>/` for a use-case work item, or
  - `docs/maintenance/<MAINT-ID>/` for a maintenance work item
- `ARCHITECTURE.md`
- `.codex/repository-settings.md`
- approved technical decisions relevant to the work item

### Use-case work-item slice

Required:

- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/ddd-design.md`
- `docs/use-cases/<UC-ID>/technical-decisions.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`

Optional but should be read when present:

- `docs/use-cases/<UC-ID>/requirements-slice.md`
- `docs/use-cases/<UC-ID>/domain-impact.md`
- `docs/use-cases/<UC-ID>/aggregate-delta.md`
- `docs/use-cases/<UC-ID>/source-map.md`

### Maintenance work-item slice

Required:

- `docs/maintenance/<MAINT-ID>/change-intent.md`
- `docs/maintenance/<MAINT-ID>/verification-goal.md`

Optional but should be read when present:

- `docs/maintenance/<MAINT-ID>/technical-decisions.md`
- `docs/maintenance/<MAINT-ID>/domain-impact.md`
- `docs/maintenance/<MAINT-ID>/source-map.md`

### Canonical domain references

When `domain-impact.md`, `aggregate-delta.md`, or the ChangeSet names canonical domain elements, read the referenced files under paths such as:

- `docs/domain/<BC-ID>/aggregates/<AGG-ID>.md`
- `docs/domain/<BC-ID>/entities/<ENTITY-ID>.md`
- `docs/domain/<BC-ID>/value-objects/<VO-ID>.md`
- `docs/domain/<BC-ID>/domain-services/<SERVICE-ID>.md`
- `docs/domain/<BC-ID>/ports/<PORT-ID>.md`

The work-item slice records impact and delta. It must not become the canonical source of truth for aggregates, entities, value objects, domain services, or ports.

### Integrated docs

Integrated documents under the design documentation area are source-of-truth references only. They are not the primary planning input for this skill, and this planner must not update them. Use the ChangeSet-local work-item slice as the planning source. Integrated docs are updated later by docs-sync after implementation and verification pass.

## Preflight Gates

### ChangeSet and work-item selection

- If `docs/changes/active/<CHG-ID>.md` does not exist or the ChangeSet ID is unclear, stop and explain that the parent ChangeSet workflow must select a ChangeSet first.
- If the work-item ID is unclear, stop and ask the parent workflow to pass exactly one work item.
- If both a use-case slice and a maintenance slice appear applicable, stop and ask the parent workflow to select one work-item type.
- If no work-item slice exists for the selected work item, stop and list the expected slice path.

### Use-case gate

For a use-case work item:

- If `use-case.md`, `event-storming.md`, `ddd-design.md`, `technical-decisions.md`, or `e2e-goal.md` is missing, stop and list the missing files.
- If `e2e-goal.md` is not explicitly approved by the user, stop and list what must be approved.
- If `technical-decisions.md` is not explicitly approved, stop and list what must be approved.

### Maintenance gate

For a maintenance work item:

- If `change-intent.md` or `verification-goal.md` is missing, stop and list the missing files.
- If `verification-goal.md` is not explicit enough to verify the change, stop and ask the parent workflow to clarify the verification goal.

### Architecture gate

- If `ARCHITECTURE.md` exists, use it as the executor-facing architecture constraint.
- If `ARCHITECTURE.md` is missing, stop and explain that the parent skill must run or complete package-structure/architecture setup first.
- Do not write `ARCHITECTURE.md` directly from this planner.

### Technical decision gate

- Read work-item technical decisions when present.
- Read repository-level approved technical decisions when referenced by the ChangeSet, work-item slice, or repository settings.
- If a referenced technical decision is unresolved and blocks implementation, stop and list what must be confirmed.
- Do not invent technical decisions to fill gaps.

### Domain conflict gate

- If the ChangeSet or `domain-impact.md` lists affected domain elements, capture their type, ID, mode, and canonical path.
- If another active ChangeSet modifies the same aggregate, entity, value object, domain service, or port, block or require explicit rebase/coordination.
- If one work item modifies a domain element and another only reuses it, record that the planner must read the latest canonical domain reference.
- If the same port/entity/value object would be created in incompatible shapes, stop and report a domain conflict.

### Static analysis gate

- Do not invoke architecture-linting skills from this planner.
- Do not require static-analysis setup to exist before writing the plan.
- Include static-analysis procedures in the plan so the executor knows what to run or set up.
- If static-analysis tooling is already present, record concrete commands from the repository.
- If static-analysis tooling is missing, add executor tasks to set up or run ArchUnit/Semgrep-based architecture linting before final verification.
