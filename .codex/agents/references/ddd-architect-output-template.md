Minimal docs/use-cases/<UC-ID>/ddd-design.md skeleton:

# <UC-ID>. DDD Design

## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|

## Behaviors
|Owner / Service|Signature|Participants|Placement|Policy Evidence|
|---|---|---|---|---|

## Application Flow
|Application Service|Signature|Description|Calls|Evidence|
|---|---|---|---|---|

## Aggregates
|Aggregate|Aggregate Root|Members|Atomic Invariant|Evidence|
|---|---|---|---|---|

## Bounded Contexts
|Bounded Context|Owned Aggregates / Entities|Boundary Reason|Communication Type|Target BC|Evidence|
|---|---|---|---|---|---|

Minimal ARCHITECTURE.md update when bounded_contexts completes:

# Architecture

## ChangeSet Scope
- ChangeSet: <CHG-ID>
- Use case: <UC-ID>
- Primary slice inputs: docs/use-cases/<UC-ID>/use-case.md, event-storming.md, e2e-goal.md

## Domain Boundary
- <BC, aggregate, entity ownership constraints for this UC>

## Dependency Direction
- <allowed dependency direction>

## Forbidden Coupling
- <forbidden package/domain/BC coupling>

## External Document Lookup Rule
- For ChangeSet work, agents must read selected slice documents first.
- Outside/canonical documents are fallback only for information missing from the slice.
