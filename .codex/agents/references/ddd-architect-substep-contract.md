## Substep contract

All output is a use-case-scoped candidate. Do not treat a candidate's Aggregate or bounded-context claim as the ChangeSet-wide canonical contract; record shared-model uncertainty in `## Integration Impact`.

1. `entity_vo`
   - Classify each relevant BC, aggregate, entity, and VO as new, modify, or reuse.
   - Evidence order: selected slice evidence, then completed candidate/`ARCHITECTURE.md` baseline, then read-only implementation fallback.
   - Define new entity attributes and new VO fields, types, required/optional state, validation/normalization rule, and command/event/policy evidence.
   - Every attribute and VO field must choose an explicit type.
   - Entity owns a VO attribute only when the entity row contains a typed property whose type is a model classified as `Value Object`, or an inline VO definition whose type is also used by that entity property.
   - For modified entity/VO definitions, show previous definition and proposed replacement.
   - Every entity/VO row must map to one Impact Assessment row whose Element Type is only Entity or Value Object.
   - Status is lifecycle classification only; never use new/modify/reuse as a visual model tag.
   - Append the `### Entity / Value Objects` Mermaid subsection in `## Architecture Visualization`.
2. `behaviors`
   - Entity method: policy belongs to one aggregate and mutates/validates that aggregate state.
   - Value-object method: validation/normalization belongs to that value object only.
   - Domain service: policy spans multiple aggregates or responsibility is not natural inside one entity/VO.
   - Include method/service signatures and policy evidence.
   - Entity/value-object methods stay inside the owning model in visualization; do not create separate visual behavior cards for them.
   - Only domain services may be visualized as separate behavior nodes.
   - Append the `### Behaviors` Mermaid subsection without changing the entity/VO visualization block.
3. `application_flow`
   - Application service may load, save, call entity methods, call domain services, call external/BC ports, compose result.
   - Application service must not contain business rules.
   - Include the service signature and a short prose description of the orchestration flow.
   - Do not write pseudocode or implementation code.
   - Append the `### Application Flow` Mermaid subsection showing orchestration only.
4. `aggregates`
   - Aggregate is a candidate transaction/atomic consistency boundary.
   - Choose an explicit aggregate name for each aggregate.
   - Never leave the aggregate name empty and never use the literal placeholder `Aggregate`.
   - Exactly one root entity per aggregate.
   - External code mutates aggregate only through root methods.
   - Include atomic invariant and command/event/policy evidence.
   - Append the `### Aggregates` Mermaid subsection.
5. `bounded_contexts`
   - BC boundary means consistent domain language and rules.
   - Split BCs when same term has different models or rules change independently.
   - Select exactly one communication type per BC relationship:
     - `internal_http`
     - `domain_event`
     - `shared_database`
   - `internal_http` means public internal HTTP API/client boundary.
   - Direct calls into another BC's internal model are forbidden.
   - Append the `### Bounded Contexts` Mermaid subsection.

## General DDD rules

- Entity has identity across time.
- Value object is immutable, compared by value, and validated at creation.
- No setters or direct mutable child collections.
- No external system calls inside entities, VOs, or aggregates.
- Business rules live in entity/VO/aggregate/domain service behavior, not application services.
- Every entity, VO, method, domain service, application service, aggregate, BC, and BC communication must trace to a command, event, policy, or UC.
- If evidence is insufficient, write Unconfirmed instead of inventing.

## Required headings and table columns

- `## Impact Assessment`: `Element Type | Element | Status | Baseline Evidence | Event Storming Evidence`
- `## Entity / Value Objects`: `Entity | Attributes / VOs | Status | Previous Definition | Proposed Definition | Evidence`
- `## Behaviors`: `Owner / Service | Signature | Participants | Placement | Policy Evidence`
- `## Application Flow`: `Application Service | Signature | Description | Calls | Evidence`
- `## Aggregates`: `Aggregate | Aggregate Root | Members | Atomic Invariant | Evidence`
- `## Bounded Contexts`: `Bounded Context | Owned Aggregates / Entities | Boundary Reason | Communication Type | Target BC | Evidence`
- `## Integration Impact`: shared-model claims and unresolved candidate conflicts to hand off to `ddd-design-integration`

## Architecture visualization contract

- `ddd-design.md` has one `## Architecture Visualization` section, after the DDD tables.
- Every completed substep has one Mermaid block in that section, with the same order as the substeps.
- Use exactly one managed range for each step:
  - `entity_vo`: `<!-- harness:ddd-visualization:entity_vo:start -->` … `<!-- harness:ddd-visualization:entity_vo:end -->`
  - `behaviors`: `<!-- harness:ddd-visualization:behaviors:start -->` … `<!-- harness:ddd-visualization:behaviors:end -->`
  - `application_flow`: `<!-- harness:ddd-visualization:application_flow:start -->` … `<!-- harness:ddd-visualization:application_flow:end -->`
  - `aggregates`: `<!-- harness:ddd-visualization:aggregates:start -->` … `<!-- harness:ddd-visualization:aggregates:end -->`
  - `bounded_contexts`: `<!-- harness:ddd-visualization:bounded_contexts:start -->` … `<!-- harness:ddd-visualization:bounded_contexts:end -->`
- On the first step, create the heading and first block. Later steps append their block. On a rerun, replace only that step's managed range.
- Use Mermaid, not UI-only cards or separate visual files.
- `entity_vo` uses `classDiagram` with typed attributes and method signatures inside model classes; entity-to-VO links come only from documented typed properties.
- `behaviors` may add domain-service nodes; entity/value-object methods remain in their model classes.
- `application_flow` uses `sequenceDiagram` or `flowchart` for application-service orchestration.
- `aggregates` and `bounded_contexts` use `flowchart` or `classDiagram` to show boundaries and allowed relations.
- Do not visualize lifecycle status values such as new, modify, or reuse.

## Entity / VO cell format

- New entity attribute: `attributeName: Type (required|optional, rule/evidence)`.
- New VO definition: `VOName { fieldName: Type, ... } (validation/normalization rule)`.
- Write each attribute/field on its own line when multiple attributes/fields exist.
- If an entity has a VO, write both the entity property and the VO definition, for example `money: Money` and `Money { amount: Decimal, currency: String }`, or write the VO as its own `Value Object` row.
- For modified attributes or VOs, put previous values in Previous Definition with `~~old~~` and replacements in Proposed Definition.
- Proposed Definition must include final entity attributes and VO field definitions, not names only.
