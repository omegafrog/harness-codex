Substep contract:
1. entity_vo
   - Classify each relevant BC, aggregate, entity, and VO as new, modify, or reuse.
   - Evidence order: completed DDD/ARCHITECTURE.md, then read-only implementation fallback, then event-storming evidence.
   - Define new entity attributes and new VO fields, types, required/optional state, validation/normalization rule, and command/event/policy evidence.
   - Every attribute and VO field must choose an explicit type.
   - Entity owns a VO attribute only when the entity row contains a typed property whose type is a model classified as `Value Object`, or an inline VO definition whose type is also used by that entity property.
   - For modified entity/VO definitions, show previous definition and proposed replacement.
   - Every entity/VO row must map to one Impact Assessment row whose Element Type is only Entity or Value Object.
   - Status is lifecycle classification only; never use new/modify/reuse as a visual model tag.
2. behaviors
   - Entity method: policy belongs to one aggregate and mutates/validates that aggregate state.
   - Value-object method: validation/normalization belongs to that value object only.
   - Domain service: policy spans multiple aggregates or responsibility is not natural inside one entity/VO.
   - Include method/service signatures and policy evidence.
   - Entity/value-object methods stay inside the owning model in visualization; do not create separate visual behavior cards for them.
   - Only domain services may be visualized as separate behavior nodes.
3. application_flow
   - Application service may load, save, call entity methods, call domain services, call external/BC ports, compose result.
   - Application service must not contain business rules.
   - Include the service signature and a short prose description of the orchestration flow.
   - Do not write pseudocode or implementation code.
4. aggregates
   - Aggregate is transaction/atomic consistency boundary.
   - Choose an explicit aggregate name for each aggregate.
   - Never leave the aggregate name empty and never use the literal placeholder `Aggregate`.
   - Exactly one root entity per aggregate.
   - External code mutates aggregate only through root methods.
   - Include atomic invariant and command/event/policy evidence.
5. bounded_contexts
   - BC boundary means consistent domain language and rules.
   - Split BCs when same term has different models or rules change independently.
   - Select exactly one communication type per BC relationship:
     - internal_http
     - domain_event
     - shared_database
   - internal_http means public internal HTTP API/client boundary.
   - Direct calls into another BC's internal model are forbidden.

General DDD rules:
- Entity has identity across time.
- Value object is immutable, compared by value, and validated at creation.
- No setters or direct mutable child collections.
- No external system calls inside entities, VOs, or aggregates.
- Business rules live in entity/VO/aggregate/domain service behavior, not application services.
- Every entity, VO, method, domain service, application service, aggregate, BC, and BC communication must trace to a command, event, policy, or UC.
- If evidence is insufficient, write Unconfirmed instead of inventing.

Required headings and table columns:
- `## Impact Assessment`: `Element Type | Element | Status | Baseline Evidence | Event Storming Evidence`
- `## Entity / Value Objects`: `Entity | Attributes / VOs | Status | Previous Definition | Proposed Definition | Evidence`
- `## Behaviors`: `Owner / Service | Signature | Participants | Placement | Policy Evidence`
- `## Application Flow`: `Application Service | Signature | Description | Calls | Evidence`
- `## Aggregates`: `Aggregate | Aggregate Root | Members | Atomic Invariant | Evidence`
- `## Bounded Contexts`: `Bounded Context | Owned Aggregates / Entities | Boundary Reason | Communication Type | Target BC | Evidence`

Entity / VO cell format:
- New entity attribute: `attributeName: Type (required|optional, rule/evidence)`.
- New VO definition: `VOName { fieldName: Type, ... } (validation/normalization rule)`.
- Write each attribute/field on its own line when multiple attributes/fields exist.
- If an entity has a VO, write both the entity property and the VO definition, for example `money: Money` and `Money { amount: Decimal, currency: String }`, or write the VO as its own `Value Object` row.
- For modified attributes or VOs, put previous values in Previous Definition with `~~old~~` and replacements in Proposed Definition.
- Proposed Definition must include final entity attributes and VO field definitions, not names only.

Visualization contract:
- Entity/value-object cards show only the model tag (`entity` or `vo`), model name, typed attributes rendered as `Type attributeName`, and method signatures.
- Entity-to-VO arrows are generated only from typed entity properties whose type is a documented VO.
- Use small section tags inside each model card to label the attributes and methods sections.
- Attribute detail/prose remains in the markdown table, not in the visual card.
- Entity/value-object method signatures come from the Behaviors table and are displayed inside the matching model card.
- Do not visualize `Status` values such as `new`, `modify`, or `reuse`.
- Do not visualize entity/value-object methods as separate cards.
- The bottom area is an Application Service method list, not a relationship/property mapping area.
- Do not render property mapping rows such as `Entity.property -> ValueObject`.
- For each application service method, render one separate rectangle containing the method name and brief responsibility/description.

