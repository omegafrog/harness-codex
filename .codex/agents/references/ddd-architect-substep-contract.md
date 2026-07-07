## Substep contract

All output is a use-case-scoped candidate. Do not treat a candidate's Aggregate or bounded-context claim as the ChangeSet-wide canonical contract; record shared-model uncertainty in `## Integration Impact`.

1. `entity_vo`
   - Classify each relevant BC, aggregate, entity, and VO as new, modify, or reuse.
   - Evidence order: selected slice evidence, then completed design docs, then read-only implementation fallback when prior model existence cannot be established from slice evidence.
   - Do not read `ARCHITECTURE.md` during candidate DDD substeps; `ddd-design-integration` owns shared architecture reconciliation.
   - Define new entity attributes and new VO fields, types, required/optional state, validation/normalization rule, and command/event/policy evidence.
   - Every attribute and VO field must choose an explicit type.
   - Entity owns a VO attribute only when the entity row contains a typed property whose type is a model classified as `Value Object`, or an inline VO definition whose type is also used by that entity property.
   - For modified entity/VO definitions, show previous definition and proposed replacement.
   - Every entity/VO row must map to one Impact Assessment row whose Element Type is only Entity or Value Object.
   - Status is lifecycle classification only; never use new/modify/reuse as a visual model tag.
   - Create the only Mermaid graph in `## Architecture Visualization` inside the `entity_vo` managed range.
2. `behaviors`
   - Entity method: policy belongs to one aggregate and mutates/validates that aggregate state.
   - Value-object method: validation/normalization belongs to that value object only.
   - Domain service: policy spans multiple aggregates or responsibility is not natural inside one entity/VO.
   - Include method/service signatures and policy evidence.
   - Entity/value-object methods stay inside the owning model in visualization; do not create separate visual behavior cards for them.
   - Update the existing single Mermaid graph and its `entity_vo` managed range.
   - Add entity/value-object methods to the owning model and domain services as separate nodes in that same diagram.
   - Do not create a separate `### Behaviors` Mermaid subsection or `behaviors` managed range.
   - If a legacy `behaviors` managed range exists, merge its supported claims into the shared graph and remove that legacy range.
3. `application_flow`
   - Application service may load, save, call entity methods, call domain services, call external/BC ports, compose result.
   - Application service must not contain business rules.
   - Include the service signature and a short prose description of the orchestration flow.
   - Do not write pseudocode or implementation code.
   - Do not append a separate `### Application Flow` Mermaid subsection.
   - Update the existing single Mermaid graph so application-service orchestration appears after the model/behavior/Aggregate area in the same graph.
4. `aggregates`
   - Aggregate is a candidate transaction/atomic consistency boundary.
   - Choose an explicit aggregate name for each aggregate.
   - Never leave the aggregate name empty and never use the literal placeholder `Aggregate`.
   - Exactly one root entity per aggregate.
   - External code mutates aggregate only through root methods.
   - Include atomic invariant and command/event/policy evidence.
   - Do not append a separate `### Aggregates` Mermaid subsection.
   - Update the existing single Mermaid graph in the `entity_vo` managed range so it includes Aggregate names, Aggregate boundaries, roots, and contained Entity/VO nodes.
   - Domain Service nodes belong inside their owning Aggregate boundary. Application Service nodes belong outside Aggregate boundaries.
5. `bounded_contexts`
   - BC boundary means consistent domain language and rules.
   - Split BCs when same term has different models or rules change independently.
   - Select exactly one communication type per BC relationship:
     - `internal_http`
     - `domain_event`
     - `shared_database`
   - `internal_http` means public internal HTTP API/client boundary.
   - Direct calls into another BC's internal model are forbidden.
   - Do not append a separate `### Bounded Contexts` Mermaid subsection.
   - Update the existing single Mermaid graph so bounded-context boundaries and allowed communication-type edges appear after the application-flow area in the same graph.

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
- Every Markdown table row must keep the same column count as its header. Escape literal pipe characters inside cells as `\|`, including pipes inside code spans, union type examples, signatures, and Mermaid labels copied into table cells.

## Architecture visualization contract

- `ddd-design.md` has one `## Architecture Visualization` section, after the DDD tables, and exactly one Mermaid graph.
- All visualization substeps share exactly one managed range:
  - `entity_vo`, `behaviors`, `application_flow`, `aggregates`, and `bounded_contexts`: `<!-- harness:ddd-visualization:entity_vo:start -->` … `<!-- harness:ddd-visualization:entity_vo:end -->`
- On `entity_vo`, create the heading and first graph. On every later visualization substep, replace that same range with one updated graph. Never append another Mermaid fence or managed range.
- Use Mermaid, not UI-only cards or separate visual files.
- The single graph uses `flowchart` when all areas must be shown together; it may use class-like nodes inside the flowchart for typed attributes and method signatures. Entity-to-VO links come only from documented typed properties; domain services are separate service nodes inside their owning Aggregate boundary once Aggregate boundaries are known; Aggregate boundaries show the explicit Aggregate name, root, contained Entity/VO nodes, and owning Domain Service nodes; application-service orchestration appears outside Aggregate boundaries and connects to aggregate roots, domain services, or ports it calls; bounded-context communication appears as grouped areas in the same graph. Entity/VO members documented in `## Aggregates` and Domain Service nodes owned by that Aggregate must be inside an Aggregate boundary. Application Service nodes must remain outside Aggregate boundaries.
- Remove legacy `behaviors`, `application_flow`, `aggregates`, or `bounded_contexts` managed ranges after merging supported claims into the single graph.
- Do not visualize lifecycle status values such as new, modify, or reuse.

## Entity / VO cell format

- New entity attribute: `attributeName: Type (required|optional, rule/evidence)`.
- New VO definition: `VOName { fieldName: Type, ... } (validation/normalization rule)`.
- Write each attribute/field on its own line when multiple attributes/fields exist.
- If an entity has a VO, write both the entity property and the VO definition, for example `money: Money` and `Money { amount: Decimal, currency: String }`, or write the VO as its own `Value Object` row.
- For modified attributes or VOs, put previous values in Previous Definition with `~~old~~` and replacements in Proposed Definition.
- Proposed Definition must include final entity attributes and VO field definitions, not names only.
